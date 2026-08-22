#include "resample.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define TAPS 24
#define HALF (TAPS / 2)

struct shim_resampler {
    unsigned in_rate;
    unsigned out_rate;
    unsigned ch;
    double phase;
    float *z;
    int have;
};

static const unsigned k_rates[] = {
    44100, 48000, 88200, 96000, 176400, 192000,
};

unsigned
shim_snap_rate(double hz)
{
    unsigned best = 0;
    double best_rel = 0.03;
    size_t i;

    if (hz < 8000.0)
        return 0;
    for (i = 0; i < sizeof(k_rates) / sizeof(k_rates[0]); i++) {
        double rel = fabs(hz - (double)k_rates[i]) / (double)k_rates[i];

        if (rel < best_rel) {
            best_rel = rel;
            best = k_rates[i];
        }
    }
    return best;
}

static float
wsinc(float x)
{
    float pix, w;

    if (x == 0.f)
        return 1.f;
    if (x <= -(float)HALF || x >= (float)HALF)
        return 0.f;
    pix = (float)M_PI * x;
    w = 0.5f + 0.5f * cosf((float)M_PI * x / (float)HALF);
    return (sinf(pix) / pix) * w;
}

struct shim_resampler *
shim_resample_new(void)
{
    return calloc(1, sizeof(struct shim_resampler));
}

void
shim_resample_free(struct shim_resampler *r)
{
    if (!r)
        return;
    free(r->z);
    free(r);
}

int
shim_resample_set(struct shim_resampler *r, unsigned in_rate, unsigned out_rate,
                  unsigned ch)
{
    float *z;

    if (!r || !in_rate || !out_rate || ch == 0 || ch > 8)
        return -1;
    if (r->z && r->in_rate == in_rate && r->out_rate == out_rate && r->ch == ch)
        return 0;
    z = calloc((size_t)TAPS * ch, sizeof(float));
    if (!z)
        return -1;
    free(r->z);
    r->z = z;
    r->in_rate = in_rate;
    r->out_rate = out_rate;
    r->ch = ch;
    r->phase = 0;
    r->have = 0;
    return 0;
}

void
shim_resample_reset(struct shim_resampler *r)
{
    if (!r)
        return;
    if (r->z && r->ch)
        memset(r->z, 0, (size_t)TAPS * r->ch * sizeof(float));
    r->phase = 0;
    r->have = 0;
}

static void
push_frame(struct shim_resampler *r, const float *frame)
{
    unsigned c, ch = r->ch;

    memmove(r->z, r->z + ch, (size_t)(TAPS - 1) * ch * sizeof(float));
    for (c = 0; c < ch; c++)
        r->z[(size_t)(TAPS - 1) * ch + c] = frame[c];
    if (r->have < TAPS)
        r->have++;
}

size_t
shim_resample_process(struct shim_resampler *r, const float *in,
                      size_t in_frames, float *out, size_t out_max,
                      size_t *in_used)
{
    size_t in_i = 0, out_i = 0;
    unsigned c, ch;
    double step;

    if (in_used)
        *in_used = 0;
    if (!r || !r->z || !in || !out || !r->in_rate || !r->out_rate)
        return 0;
    ch = r->ch;
    step = (double)r->in_rate / (double)r->out_rate;
    while (out_i < out_max) {
        while (r->have < TAPS) {
            if (in_i >= in_frames)
                goto done;
            push_frame(r, in + in_i * ch);
            in_i++;
        }
        while (r->phase >= 1.0) {
            if (in_i >= in_frames)
                goto done;
            push_frame(r, in + in_i * ch);
            in_i++;
            r->phase -= 1.0;
        }
        {
            float frac = (float)r->phase;

            for (c = 0; c < ch; c++) {
                float acc = 0.f;
                int t;

                for (t = 0; t < TAPS; t++) {
                    float x = (float)(t - (HALF - 1)) - frac;

                    acc += r->z[(size_t)t * ch + c] * wsinc(x);
                }
                out[out_i * ch + c] = acc;
            }
        }
        out_i++;
        r->phase += step;
    }
done:
    if (in_used)
        *in_used = in_i;
    return out_i;
}
