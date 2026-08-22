#pragma once

#include <stddef.h>

struct shim_resampler;

struct shim_resampler *shim_resample_new(void);
void shim_resample_free(struct shim_resampler *r);
int shim_resample_set(struct shim_resampler *r, unsigned in_rate,
                      unsigned out_rate, unsigned ch);
void shim_resample_reset(struct shim_resampler *r);
size_t shim_resample_process(struct shim_resampler *r, const float *in,
                             size_t in_frames, float *out, size_t out_max,
                             size_t *in_used);
unsigned shim_snap_rate(double hz);
