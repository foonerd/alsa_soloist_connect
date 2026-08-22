#include "shim.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

void
shim_log(const char *fmt, ...)
{
    static int once, on;
    va_list ap;

    if (!once) {
        const char *e = getenv("APULSE_DIAG");

        on = e && e[0] && e[0] != '0';
        once = 1;
    }
    if (!on)
        return;
    fputs("soloist-shim: ", stderr);
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fflush(stderr);
}

void
shim_api(const char *fn)
{
    if (fn)
        shim_log("%s\n", fn);
}

void
shim_api_hot(const char *fn)
{
    static const char *seen[32];
    static int count[32];
    static int n;
    int i;

    if (!fn)
        return;
    for (i = 0; i < n; i++) {
        if (seen[i] == fn) {
            if (count[i] >= 8) {
                if (count[i] == 8) {
                    count[i]++;
                    shim_log("%s (further calls not logged)\n", fn);
                }
                return;
            }
            count[i]++;
            shim_log("%s\n", fn);
            return;
        }
    }
    if (n < 32) {
        seen[n] = fn;
        count[n] = 1;
        n++;
    }
    shim_log("%s\n", fn);
}

const char *
shim_playback_device(void)
{
    const char *d = getenv("APULSE_PLAYBACK_DEVICE");

    return (d && d[0]) ? d : "plug:volumio";
}

int
shim_yield_requested(void)
{
    const char *p = getenv("APULSE_YIELD_PATH");

    if (!p || !p[0])
        p = SHIM_YIELD_DEFAULT;
    return access(p, F_OK) == 0;
}

int
shim_external_volume(void)
{
    const char *e = getenv("APULSE_EXTERNAL_VOLUME");

    return (e && e[0] && e[0] != '0');
}

float
shim_trim_gain(void)
{
    const char *e = getenv("APULSE_OUTPUT_TRIM_DB");
    char *end = NULL;
    double db;

    if (!e || !e[0])
        return 1.f;
    db = strtod(e, &end);
    if (end == e)
        return 1.f;
    if (db > 12)
        db = 12;
    if (db < -12)
        db = -12;
    return (float)pow(10.0, db / 20.0);
}

size_t
shim_frame_size(const pa_sample_spec *ss)
{
    size_t sample;

    if (!ss || !ss->channels)
        return 0;
    switch (ss->format) {
    case PA_SAMPLE_U8:
        sample = 1;
        break;
    case PA_SAMPLE_S16LE:
    case PA_SAMPLE_S16BE:
        sample = 2;
        break;
    case PA_SAMPLE_S24LE:
    case PA_SAMPLE_S24BE:
        sample = 3;
        break;
    case PA_SAMPLE_S24_32LE:
    case PA_SAMPLE_S24_32BE:
    case PA_SAMPLE_S32LE:
    case PA_SAMPLE_S32BE:
    case PA_SAMPLE_FLOAT32LE:
    case PA_SAMPLE_FLOAT32BE:
        sample = 4;
        break;
    default:
        return 0;
    }
    return sample * ss->channels;
}

void
shim_apply_volume(void *buf, size_t bytes, const pa_volume_t *vol,
                  const pa_sample_spec *ss)
{
    size_t fs, frames, i, ch;
    float g[PA_CHANNELS_MAX];

    if (shim_external_volume() || !buf || !vol || !ss)
        return;
    fs = shim_frame_size(ss);
    if (fs == 0)
        return;
    frames = bytes / fs;
    for (ch = 0; ch < ss->channels && ch < PA_CHANNELS_MAX; ch++)
        g[ch] = (float)vol[ch] / (float)PA_VOLUME_NORM;
    if (ss->format == PA_SAMPLE_FLOAT32LE) {
        float *p = buf;

        for (i = 0; i < frames; i++)
            for (ch = 0; ch < ss->channels; ch++)
                p[i * ss->channels + ch] *= g[ch];
    }
}

void
shim_apply_trim(void *buf, size_t bytes, const pa_sample_spec *ss)
{
    float g = shim_trim_gain();
    size_t fs, n, i;
    float *p;

    if (g == 1.f || !buf || !ss || ss->format != PA_SAMPLE_FLOAT32LE)
        return;
    fs = shim_frame_size(ss);
    if (fs == 0)
        return;
    n = (bytes / fs) * ss->channels;
    p = buf;
    for (i = 0; i < n; i++)
        p[i] *= g;
}

SHIM_EXPORT
size_t
pa_frame_size(const pa_sample_spec *spec)
{
    shim_api_hot("pa_frame_size");
    return shim_frame_size(spec);
}

SHIM_EXPORT
pa_usec_t
pa_bytes_to_usec(uint64_t length, const pa_sample_spec *spec)
{
    size_t fs = shim_frame_size(spec);

    shim_api_hot("pa_bytes_to_usec");
    if (!spec || !spec->rate || fs == 0)
        return 0;
    return (pa_usec_t)(length * 1000000ULL / (fs * (uint64_t)spec->rate));
}

SHIM_EXPORT
size_t
pa_usec_to_bytes(pa_usec_t t, const pa_sample_spec *spec)
{
    size_t fs = shim_frame_size(spec);

    shim_api_hot("pa_usec_to_bytes");
    if (!spec || !spec->rate || fs == 0)
        return 0;
    return (size_t)((uint64_t)t * spec->rate / 1000000ULL) * fs;
}

SHIM_EXPORT
struct timeval *
pa_gettimeofday(struct timeval *tv)
{
    shim_api_hot("pa_gettimeofday");
    gettimeofday(tv, NULL);
    return tv;
}

SHIM_EXPORT
pa_usec_t
pa_timeval_diff(const struct timeval *a, const struct timeval *b)
{
    const struct timeval *hi = a, *lo = b;

    shim_api_hot("pa_timeval_diff");
    if (a->tv_sec < b->tv_sec ||
        (a->tv_sec == b->tv_sec && a->tv_usec < b->tv_usec)) {
        hi = b;
        lo = a;
    }
    return (pa_usec_t)(hi->tv_sec - lo->tv_sec) * 1000000ULL +
           (pa_usec_t)(hi->tv_usec - lo->tv_usec);
}

SHIM_EXPORT
pa_cvolume *
pa_cvolume_set(pa_cvolume *a, unsigned channels, pa_volume_t v)
{
    unsigned i;

    shim_api_hot("pa_cvolume_set");
    if (!a)
        return NULL;
    a->channels = (uint8_t)channels;
    for (i = 0; i < channels && i < PA_CHANNELS_MAX; i++)
        a->values[i] = v;
    return a;
}

SHIM_EXPORT
pa_volume_t
pa_cvolume_avg(const pa_cvolume *a)
{
    unsigned i;
    uint64_t s = 0;

    shim_api_hot("pa_cvolume_avg");
    if (!a || !a->channels)
        return PA_VOLUME_MUTED;
    for (i = 0; i < a->channels; i++)
        s += a->values[i];
    return (pa_volume_t)(s / a->channels);
}

SHIM_EXPORT
const char *
pa_strerror(int error)
{
    (void)error;
    shim_api_hot("pa_strerror");
    return "error";
}

SHIM_EXPORT
pa_proplist *
pa_proplist_new(void)
{
    shim_api("pa_proplist_new");
    return calloc(1, sizeof(pa_proplist));
}

SHIM_EXPORT
void
pa_proplist_free(pa_proplist *p)
{
    size_t i;

    if (!p)
        return;
    shim_api("pa_proplist_free");
    for (i = 0; i < p->n; i++) {
        free(p->k[i]);
        free(p->v[i]);
    }
    free(p->k);
    free(p->v);
    free(p);
}

SHIM_EXPORT
int
pa_proplist_sets(pa_proplist *p, const char *key, const char *value)
{
    shim_api("pa_proplist_sets");
    if (!p || !key)
        return -1;
    p->k = realloc(p->k, (p->n + 1) * sizeof(char *));
    p->v = realloc(p->v, (p->n + 1) * sizeof(char *));
    p->k[p->n] = strdup(key);
    p->v[p->n] = value ? strdup(value) : strdup("");
    p->n++;
    return 0;
}

SHIM_EXPORT
pa_operation_state_t
pa_operation_get_state(pa_operation *o)
{
    shim_api_hot("pa_operation_get_state");
    return o ? o->state : PA_OPERATION_DONE;
}

SHIM_EXPORT
void
pa_operation_unref(pa_operation *o)
{
    if (!o)
        return;
    shim_api_hot("pa_operation_unref");
    if (--o->ref > 0)
        return;
    free(o);
}

pa_operation *
shim_op_new(pa_mainloop_api *api, void (*run)(pa_operation *))
{
    pa_operation *op = calloc(1, sizeof(*op));

    op->ref = 1;
    op->state = PA_OPERATION_RUNNING;
    op->api = api;
    op->run = run;
    return op;
}

void
shim_op_done(pa_operation *op)
{
    op->state = PA_OPERATION_DONE;
    pa_operation_unref(op);
}
