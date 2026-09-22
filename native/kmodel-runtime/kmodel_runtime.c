/*
 * Minimal nncase v3 / K210 kmodel interpreter for UnitV Browser Lab.
 *
 * The register decoding and fixed-point arithmetic follow the Apache-2.0
 * nncase 0.1/0.2 K210 emulator. This file intentionally has no libc
 * dependency so it can be compiled to a small, self-contained WebAssembly
 * module with clang --target=wasm32 -nostdlib.
 */

typedef unsigned char u8;
typedef unsigned int u32;
typedef signed int i32;
typedef unsigned long long u64;
typedef signed long long i64;

#define EXPORT(name) __attribute__((export_name(name)))
#define KPU_RAM_BYTES (2u * 1024u * 1024u)
#define KMODEL_V3 3u
#define ARCH_K210 0u
#define LAYER_DEQUANTIZE 12u
#define LAYER_K210_CONV 10240u
#define FLAG_MAIN_MEM_OUT 1u

extern u8 __heap_base;

static u32 heap_cursor;
static const u8 *model;
static u32 model_size;
static u8 *main_ram;
static u8 *kpu_ram;
static i64 *conv_acc;
static u8 *conv_output;
static u8 *pool_output;
static u8 *input_scratch;
static u32 body_start;
static u32 layer_count;
static u32 output_address;
static u32 output_size;
static u32 input_width;
static u32 input_height;
static u32 input_channels;
static u32 input_kpu_address;
static u32 final_width;
static u32 final_height;
static u32 final_channels;
static u32 output_ptr_value;
static i32 last_error;

static u32 align16(u32 value) { return (value + 15u) & ~15u; }

static void zero_bytes(u8 *dest, u32 count)
{
    for (u32 i = 0; i < count; ++i) dest[i] = 0;
}

static void copy_bytes(u8 *dest, const u8 *src, u32 count)
{
    for (u32 i = 0; i < count; ++i) dest[i] = src[i];
}

static u32 rd32(const u8 *p)
{
    return (u32)p[0] | ((u32)p[1] << 8) | ((u32)p[2] << 16) | ((u32)p[3] << 24);
}

static u64 rd64(const u8 *p)
{
    return (u64)rd32(p) | ((u64)rd32(p + 4) << 32);
}

static float rdf32(const u8 *p)
{
    union { u32 u; float f; } value;
    value.u = rd32(p);
    return value.f;
}

static i64 signed_bits(u64 value, u32 bits)
{
    const u64 sign = (u64)1 << (bits - 1u);
    const u64 mask = bits == 64u ? ~(u64)0 : (((u64)1 << bits) - 1u);
    value &= mask;
    return (i64)((value ^ sign) - sign);
}

static u32 ensure_memory(u32 end)
{
    const u32 page = 65536u;
    u32 current = __builtin_wasm_memory_size(0) * page;
    if (end <= current) return 1;
    u32 pages = (end - current + page - 1u) / page;
    return __builtin_wasm_memory_grow(0, pages) != (u32)-1;
}

EXPORT("arena_reset") void arena_reset(void)
{
    heap_cursor = align16((u32)(unsigned long)&__heap_base);
    model = (const u8 *)0;
    model_size = 0;
    last_error = 0;
}

EXPORT("arena_alloc") u32 arena_alloc(u32 size)
{
    if (!heap_cursor) arena_reset();
    u32 start = align16(heap_cursor);
    u32 end = align16(start + size);
    if (end < start || !ensure_memory(end)) return 0;
    heap_cursor = end;
    return start;
}

static int valid_range(u32 offset, u32 size)
{
    return offset <= model_size && size <= model_size - offset;
}

static void row_layout(u32 width, u32 *groups, u32 *row_len, u32 *row_pitch)
{
    if (width <= 16u) { *groups = 4u; *row_len = 1u; *row_pitch = 16u; }
    else if (width <= 32u) { *groups = 2u; *row_len = 1u; *row_pitch = 32u; }
    else { *groups = 1u; *row_len = (width + 63u) / 64u; *row_pitch = 64u; }
}

static void kpu_upload(u32 address, const u8 *src, u32 width, u32 height, u32 channels)
{
    u32 groups, row_len, row_pitch;
    row_layout(width, &groups, &row_len, &row_pitch);
    u8 *base = kpu_ram + address * 64u;
    u32 source = 0;
    for (u32 channel = 0; channel < channels; ++channel) {
        u8 *channel_origin = base + channel / groups * row_len * height * 64u + channel % groups * row_pitch;
        for (u32 y = 0; y < height; ++y) {
            u8 *row = channel_origin + y * row_len * 64u;
            for (u32 x = 0; x < width; ++x) row[x] = src[source++];
        }
    }
}

static void kpu_download(u32 address, u8 *dest, u32 width, u32 height, u32 channels)
{
    u32 groups, row_len, row_pitch;
    row_layout(width, &groups, &row_len, &row_pitch);
    const u8 *base = kpu_ram + address * 64u;
    u32 target = 0;
    for (u32 channel = 0; channel < channels; ++channel) {
        const u8 *channel_origin = base + channel / groups * row_len * height * 64u + channel % groups * row_pitch;
        for (u32 y = 0; y < height; ++y) {
            const u8 *row = channel_origin + y * row_len * 64u;
            for (u32 x = 0; x < width; ++x) dest[target++] = row[x];
        }
    }
}

static i64 carry_shift(i64 value, u32 shift)
{
    if (shift > 0u) {
        value >>= shift - 1u;
        if (value & 1) value = value < 0 ? (value >> 1) - 1 : (value >> 1) + 1;
        else value >>= 1;
    }
    return value;
}

static int inspect_conv(const u8 *arg, u32 *max_conv, u32 *max_pool, u32 *max_input, int first)
{
    if (!valid_range(rd32(arg + 8), 96u)) return 0;
    const u8 *layer = model + rd32(arg + 8);
    u64 interrupt = rd64(layer);
    u64 channels = rd64(layer + 16);
    u64 sizes = rd64(layer + 24);
    u32 in_ch = (u32)(channels & 0x3ffu) + 1u;
    u32 out_ch = (u32)((channels >> 32) & 0x3ffu) + 1u;
    u32 in_w = (u32)(sizes & 0x3ffu) + 1u;
    u32 in_h = (u32)((sizes >> 10) & 0x1ffu) + 1u;
    u32 out_w = (u32)((sizes >> 32) & 0x3ffu) + 1u;
    u32 out_h = (u32)((sizes >> 42) & 0x1ffu) + 1u;
    u64 kp = rd64(layer + 32);
    u32 kernel = (kp & 7u) == 0u ? 1u : ((kp & 7u) == 1u ? 3u : 0u);
    if (!kernel || !in_ch || !out_ch || !in_w || !in_h || !out_w || !out_h) return 0;
    u32 weight_count = ((interrupt >> 3) & 1u) ? out_ch * kernel * kernel : in_ch * out_ch * kernel * kernel;
    if (!valid_range(rd32(arg + 12), weight_count) || !valid_range(rd32(arg + 16), out_ch * 8u) || !valid_range(rd32(arg + 20), 144u)) return 0;
    u32 conv_count = in_w * in_h * out_ch;
    u32 pool_count = out_w * out_h * out_ch;
    u32 input_count = in_w * in_h * in_ch;
    if (conv_count > *max_conv) *max_conv = conv_count;
    if (pool_count > *max_pool) *max_pool = pool_count;
    if (input_count > *max_input) *max_input = input_count;
    if (first) {
        input_width = in_w; input_height = in_h; input_channels = in_ch;
        input_kpu_address = (u32)(rd64(layer + 8) & 0x7fffu);
    }
    final_width = out_w; final_height = out_h; final_channels = out_ch;
    return 1;
}

EXPORT("model_init") i32 model_init(u32 model_ptr, u32 length)
{
    model = (const u8 *)(unsigned long)model_ptr;
    model_size = length;
    last_error = 0;
    if (length < 28u) return last_error = 1;
    if (rd32(model) != KMODEL_V3) return last_error = 2;
    if ((rd32(model + 4) & 1u) == 0u) return last_error = 3;
    if (rd32(model + 8) != ARCH_K210) return last_error = 4;
    layer_count = rd32(model + 12);
    u32 main_size = rd32(model + 20);
    u32 outputs = rd32(model + 24);
    if (!layer_count || !outputs || outputs > 64u) return last_error = 5;
    u32 table_end = 28u + outputs * 8u + layer_count * 8u;
    if (!valid_range(0, table_end)) return last_error = 6;
    output_address = rd32(model + 28);
    output_size = rd32(model + 32);
    if (output_address > main_size || output_size > main_size - output_address) return last_error = 7;
    body_start = table_end;
    u32 body = body_start;
    u32 max_conv = 0, max_pool = 0, max_input = 0;
    input_width = input_height = input_channels = 0;
    final_width = final_height = final_channels = 0;
    for (u32 i = 0; i < layer_count; ++i) {
        const u8 *header = model + 28u + outputs * 8u + i * 8u;
        u32 type = rd32(header), size = rd32(header + 4);
        if (!size || !valid_range(body, size)) return last_error = 8;
        if (type == LAYER_K210_CONV) {
            if (size < 24u || !inspect_conv(model + body, &max_conv, &max_pool, &max_input, i == 0u)) return last_error = 9;
        } else if (type == LAYER_DEQUANTIZE) {
            if (size < 24u) return last_error = 10;
        } else return last_error = 11;
        body += size;
    }
    if (!input_width || !max_conv || !max_pool) return last_error = 12;
    main_ram = (u8 *)(unsigned long)arena_alloc(main_size);
    kpu_ram = (u8 *)(unsigned long)arena_alloc(KPU_RAM_BYTES);
    conv_acc = (i64 *)(unsigned long)arena_alloc(max_conv * 8u);
    conv_output = (u8 *)(unsigned long)arena_alloc(max_conv);
    pool_output = (u8 *)(unsigned long)arena_alloc(max_pool);
    input_scratch = (u8 *)(unsigned long)arena_alloc(max_input);
    if (!main_ram || !kpu_ram || !conv_acc || !conv_output || !pool_output || !input_scratch) return last_error = 13;
    zero_bytes(main_ram, main_size);
    zero_bytes(kpu_ram, KPU_RAM_BYTES);
    output_ptr_value = (u32)(unsigned long)(main_ram + output_address);
    return 0;
}

static i64 activate_value(i64 value, const u8 *table)
{
    u32 selected = 0;
    for (u32 i = 0; i < 16u; ++i) {
        i64 start = signed_bits(rd64(table + i * 8u) >> 24, 36u);
        if (start <= value) selected = i;
    }
    u64 segment = rd64(table + selected * 8u);
    u32 shift = (u32)(segment & 0xffu);
    i32 mul = (i32)signed_bits((segment >> 8) & 0xffffu, 16u);
    i64 start = signed_bits(segment >> 24, 36u);
    u32 add = table[128u + selected];
    i64 result = carry_shift((value - start) * mul, shift) + add;
    if (result < 0) return 0;
    if (result > 255) return 255;
    return result;
}

static void run_pool(u32 pool, const u8 *input, u8 *output, u32 in_w, u32 in_h, u32 out_w, u32 out_h, u32 channels)
{
    u32 kernel = 1, stride = 1, kind = 0, select_x = 0;
    if (pool == 1u) { kernel = 2; stride = 2; kind = 1; }
    else if (pool == 2u) { kernel = 2; stride = 2; kind = 2; }
    else if (pool == 3u) { kernel = 4; stride = 4; kind = 1; }
    else if (pool == 4u) { kernel = 4; stride = 4; kind = 2; }
    else if (pool == 5u) { kernel = 2; stride = 2; kind = 3; }
    else if (pool == 6u) { kernel = 2; stride = 2; kind = 3; select_x = 1; }
    else if (pool == 7u) { kernel = 4; stride = 4; kind = 3; }
    else if (pool == 8u) { kernel = 2; stride = 1; kind = 2; }
    else if (pool == 9u) { kernel = 2; stride = 1; kind = 1; }
    for (u32 channel = 0; channel < channels; ++channel) {
        const u8 *src = input + channel * in_w * in_h;
        u8 *dst = output + channel * out_w * out_h;
        for (u32 oy = 0; oy < out_h; ++oy) for (u32 ox = 0; ox < out_w; ++ox) {
            u32 origin_y = oy * stride, origin_x = ox * stride;
            if (kind == 0) { dst[oy * out_w + ox] = src[origin_y * in_w + origin_x]; continue; }
            if (kind == 3) {
                u32 sx = origin_x + select_x;
                dst[oy * out_w + ox] = origin_y < in_h && sx < in_w ? src[origin_y * in_w + sx] : 0;
                continue;
            }
            u32 aggregate = kind == 1 ? 0u : 0u, count = 0;
            for (u32 ky = 0; ky < kernel; ++ky) for (u32 kx = 0; kx < kernel; ++kx) {
                u32 y = origin_y + ky, x = origin_x + kx;
                u8 v = (y < in_h && x < in_w) ? src[y * in_w + x] : (kind == 2 ? src[(y < in_h ? y : in_h - 1u) * in_w + (x < in_w ? x : in_w - 1u)] : 0);
                if (kind == 1) { if (v > aggregate) aggregate = v; }
                else aggregate += v;
                ++count;
            }
            dst[oy * out_w + ox] = (u8)(kind == 2 ? aggregate / count : aggregate);
        }
    }
}

static int run_conv(const u8 *arg)
{
    u32 flags = rd32(arg), main_out = rd32(arg + 4);
    const u8 *layer = model + rd32(arg + 8);
    const u8 *weights = model + rd32(arg + 12);
    const u8 *bn = model + rd32(arg + 16);
    const u8 *act = model + rd32(arg + 20);
    u64 interrupt = rd64(layer);
    u64 addresses = rd64(layer + 8);
    u64 channels_reg = rd64(layer + 16);
    u64 sizes = rd64(layer + 24);
    u64 kernel_pool = rd64(layer + 32);
    u64 conv = rd64(layer + 72);
    u64 conv2 = rd64(layer + 80);
    u32 input_address = (u32)(addresses & 0x7fffu);
    u32 output_address_kpu = (u32)((addresses >> 32) & 0x7fffu);
    u32 in_ch = (u32)(channels_reg & 0x3ffu) + 1u;
    u32 out_ch = (u32)((channels_reg >> 32) & 0x3ffu) + 1u;
    u32 in_w = (u32)(sizes & 0x3ffu) + 1u;
    u32 in_h = (u32)((sizes >> 10) & 0x1ffu) + 1u;
    u32 out_w = (u32)((sizes >> 32) & 0x3ffu) + 1u;
    u32 out_h = (u32)((sizes >> 42) & 0x1ffu) + 1u;
    u32 kernel = (kernel_pool & 7u) == 0u ? 1u : 3u;
    u32 pool = (u32)((kernel_pool >> 4) & 0xfu);
    u8 pad_value = (u8)((kernel_pool >> 24) & 0xffu);
    int depthwise = (int)((interrupt >> 3) & 1u);
    u32 shift_w = (u32)(conv & 0xfu), shift_x = (u32)((conv >> 4) & 0xfu);
    i32 arg_w = (i32)signed_bits((conv >> 8) & 0xffffffu, 24u);
    i32 arg_x = (i32)signed_bits((conv >> 32) & 0xffffffu, 24u);
    i64 arg_add = signed_bits(conv2 & 0xffffffffffULL, 40u);
    u8 *linear_input = input_scratch;
    kpu_download(input_address, linear_input, in_w, in_h, in_ch);
    u32 channel_size = in_w * in_h;
    u32 groups = depthwise ? out_ch : 1u;
    u32 group_ic = depthwise ? 1u : in_ch / groups;
    u32 group_oc = depthwise ? 1u : out_ch;
    u32 pad = kernel == 1u ? 0u : 1u;
    for (u32 group = 0; group < groups; ++group) {
        const u8 *weights_group = weights + group * group_oc * group_ic * kernel * kernel;
        for (u32 oc = 0; oc < group_oc; ++oc) {
            u32 out_channel = group * group_oc + oc;
            const u8 *weights_oc = weights_group + oc * group_ic * kernel * kernel;
            for (u32 oy = 0; oy < in_h; ++oy) for (u32 ox = 0; ox < in_w; ++ox) {
                i64 value = 0, sum_x = 0, sum_w = 0;
                for (u32 ic = 0; ic < group_ic; ++ic) {
                    const u8 *src = linear_input + (group * group_ic + ic) * channel_size;
                    const u8 *weight_ic = weights_oc + ic * kernel * kernel;
                    for (u32 ky = 0; ky < kernel; ++ky) for (u32 kx = 0; kx < kernel; ++kx) {
                        i32 iy = (i32)oy - (i32)pad + (i32)ky;
                        i32 ix = (i32)ox - (i32)pad + (i32)kx;
                        u8 x = (iy < 0 || ix < 0 || iy >= (i32)in_h || ix >= (i32)in_w) ? pad_value : src[(u32)iy * in_w + (u32)ix];
                        u8 w = weight_ic[ky * kernel + kx];
                        value += (i64)x * w; sum_x += x; sum_w += w;
                    }
                }
                conv_acc[out_channel * channel_size + oy * in_w + ox] = value + (((i64)arg_x * sum_x) >> shift_x) + (((i64)arg_w * sum_w) >> shift_w) + arg_add * group_ic;
            }
        }
    }
    for (u32 oc = 0; oc < out_ch; ++oc) {
        u64 bn_reg = rd64(bn + oc * 8u);
        i32 mul = (i32)signed_bits(bn_reg & 0xffffffu, 24u);
        i32 add = (i32)signed_bits((bn_reg >> 24) & 0xffffffffu, 32u);
        u32 shift = (u32)((bn_reg >> 56) & 0xfu);
        for (u32 i = 0; i < channel_size; ++i) {
            i64 value = ((conv_acc[oc * channel_size + i] * mul) >> shift) + add;
            conv_output[oc * channel_size + i] = (u8)activate_value(value, act);
        }
    }
    run_pool(pool, conv_output, pool_output, in_w, in_h, out_w, out_h, out_ch);
    kpu_upload(output_address_kpu, pool_output, out_w, out_h, out_ch);
    if (flags & FLAG_MAIN_MEM_OUT) copy_bytes(main_ram + main_out, pool_output, out_w * out_h * out_ch);
    return 1;
}

EXPORT("model_run") i32 model_run(u32 input_ptr, u32 input_length)
{
    last_error = 0;
    if (!model || !main_ram || input_length < input_width * input_height * input_channels) return last_error = 20;
    zero_bytes(kpu_ram, KPU_RAM_BYTES);
    kpu_upload(input_kpu_address, (const u8 *)(unsigned long)input_ptr, input_width, input_height, input_channels);
    u32 outputs = rd32(model + 24);
    u32 body = body_start;
    for (u32 i = 0; i < layer_count; ++i) {
        const u8 *header = model + 28u + outputs * 8u + i * 8u;
        u32 type = rd32(header), size = rd32(header + 4);
        const u8 *arg = model + body;
        if (type == LAYER_K210_CONV) {
            if (!run_conv(arg)) return last_error = 21;
        } else if (type == LAYER_DEQUANTIZE) {
            u32 in_address = rd32(arg + 4), out_address = rd32(arg + 8), count = rd32(arg + 12);
            float scale = rdf32(arg + 16), bias = rdf32(arg + 20);
            if (in_address + count > rd32(model + 20) || out_address + count * 4u > rd32(model + 20)) return last_error = 22;
            const u8 *src = main_ram + in_address;
            float *dest = (float *)(main_ram + out_address);
            for (u32 n = 0; n < count; ++n) dest[n] = (float)src[n] * scale + bias;
        } else return last_error = 23;
        body += size;
    }
    return 0;
}

EXPORT("model_last_error") i32 model_last_error(void) { return last_error; }
EXPORT("model_layer_count") u32 model_layer_count(void) { return layer_count; }
EXPORT("model_input_width") u32 model_input_width(void) { return input_width; }
EXPORT("model_input_height") u32 model_input_height(void) { return input_height; }
EXPORT("model_input_channels") u32 model_input_channels(void) { return input_channels; }
EXPORT("model_output_width") u32 model_output_width(void) { return final_width; }
EXPORT("model_output_height") u32 model_output_height(void) { return final_height; }
EXPORT("model_output_channels") u32 model_output_channels(void) { return final_channels; }
EXPORT("model_output_ptr") u32 model_output_ptr(void) { return output_ptr_value; }
EXPORT("model_output_size") u32 model_output_size(void) { return output_size; }
