#include "shim.h"

#include <dirent.h>
#include <math.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void stream_release(pa_stream *s, int keep_position);
static void stream_clock_reset(pa_stream *s);
static void stream_clock_freeze(pa_stream *s);
static void stream_clock_hold(pa_stream *s);
static void stream_clock_start(pa_stream *s);
static pa_usec_t stream_hw_time(pa_stream *s);
static void stream_set_state(pa_stream *s, pa_stream_state_t st);
static int stream_open_pcm(pa_stream *s);

static void
adjust_attr(pa_stream *s, const pa_buffer_attr *in)
{
    size_t fs = shim_frame_size(&s->ss);
    pa_buffer_attr *a = &s->attr;
    const char *cap;
    long ms;

    if (in)
        *a = *in;
    else
        memset(a, 0xff, sizeof(*a));
    if (a->maxlength == (uint32_t)-1)
        a->maxlength = 4 * 1024 * 1024;
    if (a->tlength == (uint32_t)-1)
        a->tlength = (uint32_t)pa_usec_to_bytes(2 * 1000 * 1000, &s->ss);
    cap = getenv("APULSE_MAX_TLENGTH_MS");
    ms = cap ? strtol(cap, NULL, 10) : 0;
    if (ms > 0 && fs && s->ss.rate) {
        uint32_t c = (uint32_t)pa_usec_to_bytes((pa_usec_t)ms * 1000, &s->ss);

        if (c >= fs && a->tlength > c)
            a->tlength = c;
    }
    if (a->minreq == (uint32_t)-1)
        a->minreq = (uint32_t)pa_usec_to_bytes(20 * 1000, &s->ss);
    if (a->minreq > a->tlength / 4 && a->tlength / 4 >= fs)
        a->minreq = a->tlength / 4;
    if (a->prebuf == (uint32_t)-1)
        a->prebuf = a->tlength - a->minreq;
}

static const snd_pcm_format_t k_dev_fmts[] = {
    SND_PCM_FORMAT_S24_3LE,
    SND_PCM_FORMAT_S24_LE,
    SND_PCM_FORMAT_S16_LE,
    SND_PCM_FORMAT_FLOAT_LE,
};

static int
pick_dev_fmt(snd_pcm_t *pcm, snd_pcm_hw_params_t *hw, snd_pcm_format_t *out)
{
    size_t i;

    for (i = 0; i < sizeof(k_dev_fmts) / sizeof(k_dev_fmts[0]); i++) {
        if (snd_pcm_hw_params_test_format(pcm, hw, k_dev_fmts[i]) != 0)
            continue;
        if (snd_pcm_hw_params_set_format(pcm, hw, k_dev_fmts[i]) < 0)
            continue;
        *out = k_dev_fmts[i];
        return 0;
    }
    return -1;
}

static int32_t
float_to_s24(float x)
{
    if (x > 1.f)
        x = 1.f;
    if (x < -1.f)
        x = -1.f;
    return (int32_t)lrintf(x * 8388607.f);
}

static int16_t
float_to_s16(float x)
{
    if (x > 1.f)
        x = 1.f;
    if (x < -1.f)
        x = -1.f;
    return (int16_t)lrintf(x * 32767.f);
}

static void
pack_dev(void *dst, const void *src, size_t frames, unsigned ch,
         snd_pcm_format_t fmt)
{
    const float *in = src;
    size_t i, n = frames * ch;

    if (fmt == SND_PCM_FORMAT_S24_3LE) {
        uint8_t *p = dst;

        for (i = 0; i < n; i++) {
            int32_t v = float_to_s24(in[i]);

            p[0] = (uint8_t)v;
            p[1] = (uint8_t)(v >> 8);
            p[2] = (uint8_t)(v >> 16);
            p += 3;
        }
        return;
    }
    if (fmt == SND_PCM_FORMAT_S24_LE) {
        int32_t *p = dst;

        for (i = 0; i < n; i++)
            p[i] = float_to_s24(in[i]);
        return;
    }
    if (fmt == SND_PCM_FORMAT_S16_LE) {
        int16_t *p = dst;

        for (i = 0; i < n; i++)
            p[i] = float_to_s16(in[i]);
    }
}

static void
stream_free_io_bufs(pa_stream *s)
{
    free(s->io_buf);
    s->io_buf = NULL;
    s->io_buf_bytes = 0;
    free(s->cvt_buf);
    s->cvt_buf = NULL;
    s->cvt_buf_bytes = 0;
}

static int
pick_period(snd_pcm_t *pcm, snd_pcm_hw_params_t *hw, snd_pcm_uframes_t want,
            snd_pcm_uframes_t *out)
{
    snd_pcm_hw_params_t *tmp;
    snd_pcm_uframes_t p = want;
    int dir = 0;
    int err;

    if (snd_pcm_hw_params_malloc(&tmp) < 0)
        return -1;
    snd_pcm_hw_params_copy(tmp, hw);
    if (p > 0)
        err = snd_pcm_hw_params_set_period_size_near(pcm, tmp, &p, &dir);
    else
        err = snd_pcm_hw_params_set_period_size_first(pcm, tmp, &p, &dir);
    if (err < 0 || p == 0) {
        snd_pcm_hw_params_copy(tmp, hw);
        p = 0;
        dir = 0;
        err = snd_pcm_hw_params_set_period_size_first(pcm, tmp, &p, &dir);
    }
    snd_pcm_hw_params_free(tmp);
    if (err < 0 || p == 0)
        return -1;
    *out = p;
    return 0;
}

static int
pick_buffer(snd_pcm_t *pcm, snd_pcm_hw_params_t *hw, snd_pcm_uframes_t period,
            snd_pcm_uframes_t want, snd_pcm_uframes_t *out)
{
    snd_pcm_uframes_t n, k;

    if (period == 0)
        return -1;
    n = want / period;
    if (n < 4)
        n = 4;
    if (snd_pcm_hw_params_test_buffer_size(pcm, hw, n * period) == 0) {
        *out = n * period;
        return 0;
    }
    if (snd_pcm_hw_params_test_buffer_size(pcm, hw, 4 * period) == 0) {
        *out = 4 * period;
        return 0;
    }
    for (k = 16; k >= 2; k--) {
        if (snd_pcm_hw_params_test_buffer_size(pcm, hw, k * period) == 0) {
            *out = k * period;
            return 0;
        }
    }
    return -1;
}

void
shim_stream_set_output(pa_stream *s, int enable)
{
    pa_io_event_flags_t ev;
    int i;

    if (!s || !s->ioe || s->out_enabled == enable)
        return;
    ev = enable ? s->ioe_events : (s->ioe_events & ~PA_IO_EVENT_OUTPUT);
    for (i = 0; i < s->nioe; i++)
        if (s->ioe[i])
            s->c->api->io_enable(s->ioe[i], ev);
    s->out_enabled = enable;
}

static int
stream_prepare(pa_stream *s)
{
    snd_pcm_sframes_t avail;

    if (!s->pcm)
        return -1;
    stream_clock_freeze(s);
    if (snd_pcm_prepare(s->pcm) < 0) {
        shim_log("pcm prepare failed\n");
        shim_stream_set_output(s, 0);
        return -1;
    }
    avail = snd_pcm_avail(s->pcm);
    if (avail < 0) {
        shim_stream_set_output(s, 0);
        if (s->underflow_cb)
            s->underflow_cb(s, s->underflow_cb_userdata);
        return -1;
    }
    return 0;
}

static void
io_cb(pa_mainloop_api *a, pa_io_event *e, int fd, pa_io_event_flags_t events,
      void *userdata)
{
    pa_stream *s = userdata;
    snd_pcm_sframes_t avail, wr;
    size_t fs, got, nbytes;
    int paused;

    (void)a;
    (void)e;
    (void)fd;
    shim_stream_maybe_yield(s);
    if (!s->pcm)
        return;
    if (!(events & (PA_IO_EVENT_INPUT | PA_IO_EVENT_OUTPUT)))
        return;

    fs = shim_frame_size(&s->ss);
    if (fs == 0 || !s->io_buf)
        return;
    avail = snd_pcm_avail(s->pcm);
    if (avail < 0) {
        if (avail == -EBADFD || avail == -EAGAIN)
            return;
        shim_log("avail %s\n", snd_strerror((int)avail));
        stream_prepare(s);
        return;
    }
    if (avail <= 0) {
        if (s->paused || ring_readable(s->rb) < fs)
            return;
        if (snd_pcm_state(s->pcm) != SND_PCM_STATE_PREPARED)
            return;
        avail = (snd_pcm_sframes_t)(s->io_buf_bytes / fs);
        if (avail <= 0)
            return;
    }
    nbytes = (size_t)avail * fs;
    if (nbytes > s->io_buf_bytes)
        nbytes = s->io_buf_bytes;
    avail = (snd_pcm_sframes_t)(nbytes / fs);
    if (s->dev_frame_size && s->cvt_buf_bytes) {
        size_t mf = s->cvt_buf_bytes / s->dev_frame_size;

        if ((size_t)avail > mf)
            avail = (snd_pcm_sframes_t)mf;
    }
    if (avail <= 0)
        return;

    paused = s->paused;
    if (!(events & PA_IO_EVENT_OUTPUT))
        return;

    if (paused) {
        size_t dfs = s->dev_frame_size ? s->dev_frame_size : fs;
        void *zbuf = s->cvt_buf ? s->cvt_buf : s->io_buf;

        if (snd_pcm_state(s->pcm) != SND_PCM_STATE_RUNNING)
            return;
        memset(zbuf, 0, (size_t)avail * dfs);
        wr = snd_pcm_writei(s->pcm, zbuf, (snd_pcm_uframes_t)avail);
        if (wr < 0 && wr != -EAGAIN)
            stream_prepare(s);
        return;
    }

    got = ring_peek(s->rb, s->io_buf, (size_t)avail * fs);
    if (got < fs) {
        shim_stream_set_output(s, 0);
        return;
    }
    got = (got / fs) * fs;
    shim_apply_volume(s->io_buf, got, s->volume, &s->ss);
    shim_apply_trim(s->io_buf, got, &s->ss);
    {
        snd_pcm_uframes_t frames = got / fs;
        const void *out = s->io_buf;

        if (s->dev_fmt != SND_PCM_FORMAT_FLOAT_LE &&
            s->dev_fmt != SND_PCM_FORMAT_FLOAT_BE) {
            if (!s->cvt_buf || !s->dev_frame_size)
                return;
            pack_dev(s->cvt_buf, s->io_buf, frames, s->ss.channels, s->dev_fmt);
            out = s->cvt_buf;
        }
        wr = snd_pcm_writei(s->pcm, out, frames);
    }
    if (wr < 0 && wr != -EAGAIN) {
        shim_log("writei %s, avail=%ld\n", snd_strerror((int)wr), (long)avail);
        stream_prepare(s);
        return;
    }
    if (wr > 0) {
        ring_drop(s->rb, (size_t)wr * fs);
        stream_clock_start(s);
        if (s->started_cb)
            s->started_cb(s, s->started_cb_userdata);
        s->started_cb = NULL;
    }
}

static void *
pcm_close_worker(void *arg)
{
    snd_pcm_t *pcm = arg;

    snd_pcm_nonblock(pcm, 1);
    snd_pcm_drop(pcm);
    snd_pcm_close(pcm);
    return NULL;
}

static void
stream_abandon_pcm(snd_pcm_t *pcm)
{
    pthread_t t;
    pthread_attr_t attr;

    if (!pcm)
        return;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    if (pthread_create(&t, &attr, pcm_close_worker, pcm) != 0)
        shim_log("pcm close worker failed, abandoning handle\n");
    pthread_attr_destroy(&attr);
}

static void
quiet_alsa(const char *file, int line, const char *fn, int err, const char *fmt,
           ...)
{
    (void)file;
    (void)line;
    (void)fn;
    (void)err;
    (void)fmt;
}

static int
stream_open_pcm(pa_stream *s)
{
    snd_pcm_hw_params_t *hw;
    snd_pcm_sw_params_t *sw;
    snd_pcm_uframes_t period = 0, buffer = 0, want_p = 0, want_b = 0;
    unsigned rate;
    int err, dir = 0, nfds, k, resample = 0;
    size_t fs = shim_frame_size(&s->ss);
    struct pollfd *fds;
    const char *dev = shim_playback_device();

    if (s->pcm)
        return 0;
    if (shim_yield_requested())
        return -1;

    snd_lib_error_set_handler(quiet_alsa);
    err = snd_pcm_open(&s->pcm, dev, SND_PCM_STREAM_PLAYBACK, 0);
    snd_lib_error_set_handler(NULL);
    if (err < 0) {
        shim_log("pcm open %s failed: %s\n", dev, snd_strerror(err));
        return -1;
    }

    snd_pcm_hw_params_malloc(&hw);
    snd_pcm_hw_params_any(s->pcm, hw);
    snd_pcm_hw_params_set_access(s->pcm, hw, SND_PCM_ACCESS_RW_INTERLEAVED);
    if (pick_dev_fmt(s->pcm, hw, &s->dev_fmt) < 0)
        goto fail;
    {
        int bits = snd_pcm_format_physical_width(s->dev_fmt);

        if (bits <= 0)
            goto fail;
        s->dev_frame_size = (size_t)(bits / 8) * s->ss.channels;
    }
    if (snd_pcm_hw_params_set_channels(s->pcm, hw, s->ss.channels) < 0)
        goto fail;
    rate = s->ss.rate;
    resample = 1;
    snd_pcm_hw_params_set_rate_resample(s->pcm, hw, 1);
    if (snd_pcm_hw_params_set_rate_near(s->pcm, hw, &rate, &dir) < 0)
        goto fail;
    if (fs)
        want_p = s->attr.minreq / fs;
    if (pick_period(s->pcm, hw, want_p, &period) < 0)
        goto fail;
    if (snd_pcm_hw_params_set_period_size(s->pcm, hw, period, 0) < 0)
        goto fail;
    if (fs)
        want_b = s->attr.tlength / fs;
    if (pick_buffer(s->pcm, hw, period, want_b, &buffer) < 0)
        goto fail;
    if (snd_pcm_hw_params_set_buffer_size(s->pcm, hw, buffer) < 0)
        goto fail;
    if (snd_pcm_hw_params(s->pcm, hw) < 0)
        goto fail;
    snd_pcm_hw_params_get_period_size(hw, &period, &dir);
    snd_pcm_hw_params_get_buffer_size(hw, &buffer);
    snd_pcm_hw_params_free(hw);
    hw = NULL;

    s->period = period;
    stream_free_io_bufs(s);
    s->io_buf_bytes = (size_t)period * 4 * fs;
    if (s->io_buf_bytes < fs)
        s->io_buf_bytes = fs * 4;
    s->io_buf = malloc(s->io_buf_bytes);
    if (!s->io_buf)
        goto fail;
    if (s->dev_fmt != SND_PCM_FORMAT_FLOAT_LE &&
        s->dev_fmt != SND_PCM_FORMAT_FLOAT_BE && s->dev_frame_size) {
        s->cvt_buf_bytes = (size_t)period * 4 * s->dev_frame_size;
        if (s->cvt_buf_bytes < s->dev_frame_size)
            s->cvt_buf_bytes = s->dev_frame_size * 4;
        s->cvt_buf = malloc(s->cvt_buf_bytes);
        if (!s->cvt_buf)
            goto fail;
    }

    snd_pcm_sw_params_malloc(&sw);
    snd_pcm_sw_params_current(s->pcm, sw);
    snd_pcm_sw_params_set_avail_min(s->pcm, sw, period);
    snd_pcm_sw_params(s->pcm, sw);
    snd_pcm_sw_params_free(sw);
    if (snd_pcm_prepare(s->pcm) < 0)
        goto fail;

    nfds = snd_pcm_poll_descriptors_count(s->pcm);
    fds = calloc((size_t)nfds, sizeof(*fds));
    s->ioe = calloc((size_t)nfds, sizeof(*s->ioe));
    s->nioe = nfds;
    snd_pcm_poll_descriptors(s->pcm, fds, nfds);
    for (k = 0; k < nfds; k++) {
        pa_io_event_flags_t ev = 0;

        if (fds[k].events & POLLIN)
            ev |= PA_IO_EVENT_INPUT;
        if (fds[k].events & POLLOUT)
            ev |= PA_IO_EVENT_OUTPUT;
        s->ioe[k] = s->c->api->io_new(s->c->api, fds[k].fd, ev, io_cb, s);
        s->ioe[k]->pcm = s->pcm;
        s->ioe_events = ev;
    }
    s->out_enabled = 1;
    free(fds);
    if (s->ss.rate)
        s->configured_sink_usec =
            (pa_usec_t)((uint64_t)buffer * 1000000ULL / s->ss.rate);
    shim_log("pcm open %s period=%lu buffer=%lu rate=%u fmt=%s resample=%d\n",
             dev, (unsigned long)period, (unsigned long)buffer, rate,
             snd_pcm_format_name(s->dev_fmt), resample);
    return 0;

fail:
    if (hw)
        snd_pcm_hw_params_free(hw);
    stream_free_io_bufs(s);
    if (s->pcm) {
        stream_abandon_pcm(s->pcm);
        s->pcm = NULL;
    }
    return -1;
}

static void
stream_detach_io(pa_stream *s)
{
    int i;

    if (!s->ioe)
        return;
    for (i = 0; i < s->nioe; i++)
        if (s->ioe[i])
            s->c->api->io_free(s->ioe[i]);
    free(s->ioe);
    s->ioe = NULL;
    s->nioe = 0;
    s->out_enabled = 0;
}

static void
stream_close_pcm(pa_stream *s, int keep_position)
{
    if (s->pcm) {
        stream_abandon_pcm(s->pcm);
        s->pcm = NULL;
        shim_log("pcm close handed off keep=%d\n", keep_position);
    }
    stream_free_io_bufs(s);
    if (s->rb)
        ring_drop(s->rb, ring_readable(s->rb));
    if (keep_position)
        stream_clock_hold(s);
    else {
        s->timing.write_index = 0;
        s->timing.read_index = 0;
        stream_clock_reset(s);
    }
}

void
shim_finish_pending_releases(pa_mainloop *m)
{
    pa_stream **list;
    int i, n;

    if (!m || m->npending <= 0)
        return;
    list = m->pending_release;
    n = m->npending;
    m->pending_release = NULL;
    m->npending = 0;
    for (i = 0; i < n; i++) {
        pa_stream *s = list[i];

        stream_detach_io(s);
        stream_close_pcm(s, s->release_keep_position);
        s->release_pending = 0;
        pa_stream_unref(s);
    }
    free(list);
}

static void
stream_release(pa_stream *s, int keep_position)
{
    if (!s || (!s->pcm && !s->release_pending))
        return;
    stream_detach_io(s);
    stream_close_pcm(s, keep_position);
    s->release_pending = 0;
}

int
shim_stream_acquire(pa_stream *s)
{
    if (s->pcm)
        return 0;
    if (shim_yield_requested())
        return -1;
    if (stream_open_pcm(s) < 0)
        return -1;
    shim_stream_set_output(s, 0);
    return 0;
}

static void
acquire_retry(pa_mainloop_api *a, pa_time_event *e, const struct timeval *tv,
              void *userdata)
{
    pa_stream *s = userdata;

    (void)tv;
    s->acquire_ev = NULL;
    if (a && a->time_free)
        a->time_free(e);
    if (!s->want_running)
        return;
    if (shim_stream_acquire(s) == 0) {
        s->paused = 0;
        stream_clock_start(s);
        shim_stream_set_output(s, 1);
        return;
    }
    shim_stream_schedule_acquire(s);
}

void
shim_stream_schedule_acquire(pa_stream *s)
{
    static const unsigned back[] = {50, 100, 200, 400, 800};
    unsigned i, ms;

    if (s->acquire_ev && s->c->api->time_free) {
        s->c->api->time_free(s->acquire_ev);
        s->acquire_ev = NULL;
    }
    if (shim_yield_requested()) {
        s->acquire_ev = shim_after_ms(s->c->api, 50, acquire_retry, s);
        return;
    }
    i = (unsigned)s->acquire_attempts;
    if (i >= 5)
        i = 4;
    ms = back[i];
    if (s->acquire_attempts < 5)
        s->acquire_attempts++;
    s->acquire_ev = shim_after_ms(s->c->api, ms, acquire_retry, s);
}

void
shim_stream_maybe_yield(pa_stream *s)
{
    if (!s || !s->pcm || !shim_yield_requested())
        return;
    if (s->acquire_ev && s->c->api->time_free) {
        s->c->api->time_free(s->acquire_ev);
        s->acquire_ev = NULL;
    }
    s->acquire_attempts = 0;
    stream_clock_freeze(s);
    stream_release(s, 1);
}

static void
stream_clock_reset(pa_stream *s)
{
    s->clock_origin_hw = 0;
    s->clock_last_hw = -1;
    s->clock_frozen_usec = 0;
    s->clock_last_played = 0;
    s->clock_running = 0;
    s->clock_have_origin = 0;
    s->clock_have_path = 0;
    s->clock_path[0] = 0;
    s->clock_model_valid = 0;
}

static void
stream_clock_start(pa_stream *s)
{
    s->clock_running = 1;
}

static void
stream_clock_freeze(pa_stream *s)
{
    if (!s->clock_running)
        return;
    s->clock_frozen_usec = s->clock_last_played;
    s->clock_running = 0;
}

static void
stream_clock_hold(pa_stream *s)
{
    pa_usec_t held = s->clock_frozen_usec ? s->clock_frozen_usec
                                          : s->clock_last_played;
    int64_t bytes;

    stream_clock_reset(s);
    s->clock_frozen_usec = held;
    s->clock_last_played = held;
    bytes = (int64_t)pa_usec_to_bytes(held, &s->ss);
    if (bytes < 0)
        bytes = 0;
    s->timing.write_index = bytes;
    s->timing.read_index = bytes;
}

static int
read_key_long(const char *path, const char *key, long *out)
{
    FILE *f = fopen(path, "r");
    char line[256];
    size_t klen = strlen(key);

    if (!f)
        return -1;
    while (fgets(line, sizeof(line), f)) {
        if (strncmp(line, key, klen) == 0 &&
            (line[klen] == ':' || line[klen] == ' ' || line[klen] == '=')) {
            char *p = line + klen;

            while (*p == ':' || *p == ' ' || *p == '=')
                p++;
            *out = strtol(p, NULL, 10);
            fclose(f);
            return 0;
        }
    }
    fclose(f);
    return -1;
}

static int
status_running(const char *path)
{
    FILE *f = fopen(path, "r");
    char line[128];
    int ok = 0;

    if (!f)
        return 0;
    if (fgets(line, sizeof(line), f) && strncmp(line, "state: RUNNING", 14) == 0)
        ok = 1;
    fclose(f);
    return ok;
}

static int
path_join(char *dst, size_t dstsz, const char *a, const char *b)
{
    size_t na, nb;

    if (!dst || !a || !b || dstsz == 0)
        return -1;
    na = strlen(a);
    nb = strlen(b);
    if (na + 1 + nb + 1 > dstsz)
        return -1;
    memcpy(dst, a, na);
    dst[na] = '/';
    memcpy(dst + na + 1, b, nb + 1);
    return 0;
}

static int
path_append(char *dst, size_t dstsz, const char *suffix)
{
    size_t n, ns;

    if (!dst || !suffix || dstsz == 0)
        return -1;
    n = strlen(dst);
    ns = strlen(suffix);
    if (n + 1 + ns + 1 > dstsz)
        return -1;
    dst[n] = '/';
    memcpy(dst + n + 1, suffix, ns + 1);
    return 0;
}

static int
card_loopback(const char *dir)
{
    char idp[SHIM_PATH_MAX], id[64];
    FILE *f;

    if (path_join(idp, sizeof(idp), dir, "id") < 0)
        return 0;
    f = fopen(idp, "r");
    if (!f)
        return 0;
    if (!fgets(id, sizeof(id), f)) {
        fclose(f);
        return 0;
    }
    fclose(f);
    return strncmp(id, "Loopback", 8) == 0;
}

struct snap {
    char path[SHIM_PATH_MAX];
    long hw_ptr;
    long delay;
    long buffer;
    unsigned rate;
    int ioplug;
};

static int
read_snap(const char *status, struct snap *o)
{
    char hw[SHIM_PATH_MAX];
    size_t n = strlen(status);

    memset(o, 0, sizeof(*o));
    if (n >= sizeof(o->path) || n < 7 || n + 4 > sizeof(hw) ||
        strcmp(status + n - 6, "status") != 0)
        return -1;
    memcpy(o->path, status, n + 1);
    memcpy(hw, status, n - 6);
    memcpy(hw + n - 6, "hw_params", 10);
    if (!status_running(status))
        return -1;
    if (read_key_long(status, "hw_ptr", &o->hw_ptr) < 0)
        return -1;
    if (read_key_long(status, "delay", &o->delay) < 0)
        o->delay = -1;
    if (read_key_long(hw, "buffer_size", &o->buffer) < 0)
        o->buffer = -1;
    {
        long r = 0;

        if (read_key_long(hw, "rate", &r) == 0)
            o->rate = (unsigned)r;
    }
    o->ioplug = (o->buffer >= SHIM_IOPLUG_MAX_FRAMES);
    return 0;
}

static int
scan_hw(unsigned want, struct snap *best)
{
    DIR *cards = opendir("/proc/asound");
    struct dirent *ce;
    struct snap pick;
    int found = 0;

    if (!cards)
        return -1;
    memset(&pick, 0, sizeof(pick));
    while ((ce = readdir(cards))) {
        char card[SHIM_PATH_MAX];
        DIR *pcms;
        struct dirent *pe;

        if (strncmp(ce->d_name, "card", 4) != 0)
            continue;
        if (path_join(card, sizeof(card), "/proc/asound", ce->d_name) < 0)
            continue;
        if (card_loopback(card))
            continue;
        pcms = opendir(card);
        if (!pcms)
            continue;
        while ((pe = readdir(pcms))) {
            char st[SHIM_PATH_MAX];
            struct snap snap;
            size_t plen = strlen(pe->d_name);

            if (plen < 4 || strncmp(pe->d_name, "pcm", 3) != 0)
                continue;
            if (pe->d_name[plen - 1] != 'p')
                continue;
            if (path_join(st, sizeof(st), card, pe->d_name) < 0)
                continue;
            if (path_append(st, sizeof(st), "sub0/status") < 0)
                continue;
            if (read_snap(st, &snap) < 0)
                continue;
            if (want && snap.rate && snap.rate != want)
                continue;
            if (!found) {
                pick = snap;
                found = 1;
                continue;
            }
            if (pick.ioplug && !snap.ioplug)
                pick = snap;
            else if (pick.ioplug == snap.ioplug && snap.delay >= 0 &&
                     (pick.delay < 0 || snap.delay < pick.delay))
                pick = snap;
        }
        closedir(pcms);
    }
    closedir(cards);
    if (!found)
        return -1;
    *best = pick;
    return 0;
}

static int64_t
unwrap_hw(int64_t last, long raw)
{
    int64_t cur = (int64_t)(uint32_t)raw;

    if (last < 0)
        return (int64_t)raw;
    {
        int64_t last32 = last & 0xffffffffLL;
        int64_t hi = last - last32;

        if (cur + 0x40000000LL < last32)
            hi += 0x100000000LL;
        return hi + cur;
    }
}

static void
model_update(pa_stream *s, int64_t hw, const struct timeval *now)
{
    long elapsed;
    double measured;

    if (!s->clock_model_valid) {
        s->clock_model_at = *now;
        s->clock_model_frames = hw;
        s->clock_model_rate = (double)s->ss.rate;
        s->clock_model_valid = 1;
        return;
    }
    elapsed = (long)(now->tv_sec - s->clock_model_at.tv_sec) * 1000000L +
              (now->tv_usec - s->clock_model_at.tv_usec);
    if (elapsed < SHIM_CLOCK_FIT_US)
        return;
    measured = (double)(hw - s->clock_model_frames) * 1000000.0 / (double)elapsed;
    if (s->ss.rate &&
        fabs(measured - (double)s->ss.rate) / (double)s->ss.rate <
            SHIM_CLOCK_MAX_DRIFT)
        s->clock_model_rate = s->clock_model_rate * 0.75 + measured * 0.25;
    s->clock_model_at = *now;
    s->clock_model_frames = hw;
}

static int64_t
model_frames(pa_stream *s, const struct timeval *now, int64_t hw, long period)
{
    long elapsed;
    int64_t est;

    if (!s->clock_model_valid)
        return hw;
    elapsed = (long)(now->tv_sec - s->clock_model_at.tv_sec) * 1000000L +
              (now->tv_usec - s->clock_model_at.tv_usec);
    if (elapsed < 0)
        elapsed = 0;
    est = s->clock_model_frames +
          (int64_t)(s->clock_model_rate * (double)elapsed / 1000000.0);
    if (period > 0 && est > hw + period)
        est = hw + period;
    if (est < hw)
        est = hw;
    return est;
}

static pa_usec_t
stream_hw_time(pa_stream *s)
{
    struct snap snap;
    struct timeval now;
    int64_t hw;
    pa_usec_t usec;
    long ptr = 0;

    if (!s->clock_running)
        return s->clock_frozen_usec;
    gettimeofday(&now, NULL);
    if (!s->clock_have_path) {
        if (scan_hw(s->ss.rate, &snap) < 0)
            return s->clock_last_played;
        memcpy(s->clock_path, snap.path, sizeof(s->clock_path));
        s->clock_have_path = 1;
        ptr = snap.hw_ptr;
    } else if (!status_running(s->clock_path) ||
               read_key_long(s->clock_path, "hw_ptr", &ptr) < 0) {
        s->clock_have_path = 0;
        return s->clock_last_played;
    }
    hw = unwrap_hw(s->clock_last_hw, ptr);
    s->clock_last_hw = hw;
    model_update(s, hw, &now);
    hw = model_frames(s, &now, hw, (long)s->period);
    if (!s->clock_have_origin) {
        if (s->clock_frozen_usec && s->ss.rate) {
            int64_t back = (int64_t)((uint64_t)s->clock_frozen_usec *
                                     s->ss.rate / 1000000ULL);

            s->clock_origin_hw = hw - back;
        } else {
            s->clock_origin_hw = hw;
        }
        s->clock_have_origin = 1;
    }
    if (s->ss.rate == 0)
        return s->clock_last_played;
    usec = (pa_usec_t)((hw - s->clock_origin_hw) * 1000000LL / s->ss.rate);
    if (usec < s->clock_last_played)
        usec = s->clock_last_played;
    s->clock_last_played = usec;
    return usec;
}

void
shim_stream_update_timing(pa_stream *s)
{
    pa_usec_t hw;
    int64_t played;
    size_t fs = shim_frame_size(&s->ss);

    shim_stream_maybe_yield(s);
    gettimeofday(&s->timing.timestamp, NULL);
    hw = stream_hw_time(s);
    played = (int64_t)pa_usec_to_bytes(hw, &s->ss);
    if (fs)
        played -= played % (int64_t)fs;
    if (s->timing.write_index > 0 && played < s->timing.read_index)
        played = s->timing.read_index;
    if (played > s->timing.write_index)
        played = s->timing.write_index;
    if (played < 0)
        played = 0;
    s->timing.read_index = played;
    s->timing.read_index_corrupt = 0;
    s->timing.write_index_corrupt = 0;
    s->timing.playing = !s->paused;
    s->timing.sink_usec = 0;
    s->timing.transport_usec = 0;
    s->timing.configured_sink_usec = s->configured_sink_usec;
}

static void
stream_set_state(pa_stream *s, pa_stream_state_t st)
{
    if (s->state == st)
        return;
    s->state = st;
    if (s->state_cb)
        s->state_cb(s, s->state_cb_userdata);
}

static pa_stream *
stream_alloc(pa_context *c, const pa_sample_spec *ss)
{
    pa_stream *s = calloc(1, sizeof(*s));
    size_t fs, rb;
    unsigned i;

    s->ref = 1;
    s->c = c;
    s->idx = (uint32_t)c->next_idx++;
    s->state = PA_STREAM_UNCONNECTED;
    s->ss = *ss;
    s->paused = 1;
    s->clock_last_hw = -1;
    for (i = 0; i < PA_CHANNELS_MAX; i++)
        s->volume[i] = PA_VOLUME_NORM;
    fs = shim_frame_size(ss);
    rb = fs * ss->rate / 2;
    if (rb < 72 * 1024)
        rb = 72 * 1024;
    s->rb = ring_new(rb);
    stream_clock_reset(s);
    adjust_attr(s, NULL);
    shim_context_add_stream(c, s);
    c->ref++;
    return s;
}

SHIM_EXPORT
pa_stream *
pa_stream_new(pa_context *c, const char *name, const pa_sample_spec *ss,
              const pa_channel_map *map)
{
    (void)name;
    (void)map;
    shim_api("pa_stream_new");
    if (!c || !ss)
        return NULL;
    return stream_alloc(c, ss);
}

SHIM_EXPORT
pa_stream *
pa_stream_new_with_proplist(pa_context *c, const char *name,
                            const pa_sample_spec *ss, const pa_channel_map *map,
                            pa_proplist *p)
{
    (void)p;
    shim_api("pa_stream_new_with_proplist");
    return pa_stream_new(c, name, ss, map);
}

SHIM_EXPORT
int
pa_stream_connect_playback(pa_stream *s, const char *dev,
                           const pa_buffer_attr *attr, pa_stream_flags_t flags,
                           const pa_cvolume *volume, pa_stream *sync)
{
    int corked = !!(flags & PA_STREAM_START_CORKED);

    shim_api("pa_stream_connect_playback");
    (void)dev;
    (void)volume;
    (void)sync;
    adjust_attr(s, attr);
    s->paused = corked;
    s->want_running = !corked;
    shim_log("connect corked=%d yield=%d tlength=%u minreq=%u rate=%u\n",
             corked, shim_yield_requested(), s->attr.tlength, s->attr.minreq,
             s->ss.rate);
    if (shim_yield_requested() || stream_open_pcm(s) < 0) {
        stream_set_state(s, PA_STREAM_READY);
        if (!corked)
            shim_stream_schedule_acquire(s);
        return 0;
    }
    if (corked)
        shim_stream_set_output(s, 0);
    stream_set_state(s, PA_STREAM_READY);
    return 0;
}

static void
cork_run(pa_operation *op)
{
    pa_stream *s = op->s;

    shim_log("cork %d pcm=%d\n", (int)op->idx, s->pcm != NULL);
    if (op->idx) {
        if (s->acquire_ev && s->c->api->time_free) {
            s->c->api->time_free(s->acquire_ev);
            s->acquire_ev = NULL;
        }
        s->acquire_attempts = 0;
        s->want_running = 0;
        stream_clock_freeze(s);
        s->paused = 1;
        if (!shim_yield_requested() && s->pcm)
            shim_stream_set_output(s, 1);
        else
            shim_stream_maybe_yield(s);
    } else {
        s->want_running = 1;
        if (s->pcm) {
            stream_clock_start(s);
            s->paused = 0;
            shim_stream_set_output(s, 1);
        } else if (shim_stream_acquire(s) == 0) {
            s->paused = 0;
            stream_clock_start(s);
            shim_stream_set_output(s, 1);
        } else {
            shim_stream_schedule_acquire(s);
        }
    }
    if (op->cb)
        ((pa_stream_success_cb_t)op->cb)(s, 1, op->userdata);
    shim_op_done(op);
}

SHIM_EXPORT
pa_operation *
pa_stream_cork(pa_stream *s, int b, pa_stream_success_cb_t cb, void *userdata)
{
    pa_operation *op = shim_op_new(s->c->api, cork_run);

    shim_api("pa_stream_cork");
    op->s = s;
    op->idx = (uint32_t)b;
    op->cb = (void *)cb;
    op->userdata = userdata;
    shim_op_launch(op);
    return op;
}

static void
flush_run(pa_operation *op)
{
    pa_stream *s = op->s;

    if (s->rb)
        ring_drop(s->rb, ring_readable(s->rb));
    s->timing.write_index = 0;
    s->timing.read_index = 0;
    stream_clock_reset(s);
    if (s->pcm) {
        snd_pcm_drop(s->pcm);
        snd_pcm_prepare(s->pcm);
    }
    shim_stream_set_output(s, 0);
    if (op->cb)
        ((pa_stream_success_cb_t)op->cb)(s, 1, op->userdata);
    shim_op_done(op);
}

SHIM_EXPORT
pa_operation *
pa_stream_flush(pa_stream *s, pa_stream_success_cb_t cb, void *userdata)
{
    pa_operation *op = shim_op_new(s->c->api, flush_run);

    shim_api("pa_stream_flush");
    op->s = s;
    op->cb = (void *)cb;
    op->userdata = userdata;
    shim_op_launch(op);
    return op;
}

SHIM_EXPORT
int
pa_stream_disconnect(pa_stream *s)
{
    shim_api("pa_stream_disconnect");
    if (s->state != PA_STREAM_READY)
        return PA_ERR_BADSTATE;
    shim_log("stream disconnect\n");
    if (s->acquire_ev && s->c->api->time_free) {
        s->c->api->time_free(s->acquire_ev);
        s->acquire_ev = NULL;
    }
    stream_release(s, 0);
    stream_set_state(s, PA_STREAM_TERMINATED);
    return 0;
}

SHIM_EXPORT
uint32_t
pa_stream_get_index(pa_stream *s)
{
    shim_api_hot("pa_stream_get_index");
    return s->idx;
}

SHIM_EXPORT
pa_stream_state_t
pa_stream_get_state(pa_stream *s)
{
    shim_api_hot("pa_stream_get_state");
    return s->state;
}

SHIM_EXPORT
const pa_timing_info *
pa_stream_get_timing_info(pa_stream *s)
{
    shim_api_hot("pa_stream_get_timing_info");
    shim_stream_update_timing(s);
    return &s->timing;
}

static void
update_timing_run(pa_operation *op)
{
    shim_stream_update_timing(op->s);
    if (op->cb)
        ((pa_stream_success_cb_t)op->cb)(op->s, 1, op->userdata);
    shim_op_done(op);
}

SHIM_EXPORT
pa_operation *
pa_stream_update_timing_info(pa_stream *s, pa_stream_success_cb_t cb,
                             void *userdata)
{
    pa_operation *op = shim_op_new(s->c->api, update_timing_run);

    shim_api_hot("pa_stream_update_timing_info");
    op->s = s;
    op->cb = (void *)cb;
    op->userdata = userdata;
    shim_op_launch(op);
    return op;
}

SHIM_EXPORT
int
pa_stream_is_corked(pa_stream *s)
{
    shim_api_hot("pa_stream_is_corked");
    return s->paused;
}

SHIM_EXPORT
void
pa_stream_set_state_callback(pa_stream *s, pa_stream_notify_cb_t cb, void *u)
{
    shim_api("pa_stream_set_state_callback");
    s->state_cb = cb;
    s->state_cb_userdata = u;
}

SHIM_EXPORT
void
pa_stream_set_started_callback(pa_stream *s, pa_stream_notify_cb_t cb, void *u)
{
    shim_api("pa_stream_set_started_callback");
    s->started_cb = cb;
    s->started_cb_userdata = u;
}

SHIM_EXPORT
void
pa_stream_set_underflow_callback(pa_stream *s, pa_stream_notify_cb_t cb, void *u)
{
    shim_api("pa_stream_set_underflow_callback");
    s->underflow_cb = cb;
    s->underflow_cb_userdata = u;
}

SHIM_EXPORT
size_t
pa_stream_writable_size(pa_stream *s)
{
    size_t room_ring, fs;
    int64_t fill, room;

    shim_api_hot("pa_stream_writable_size");
    if (!s->rb)
        return 0;
    room_ring = ring_writable(s->rb);
    fs = shim_frame_size(&s->ss);
    fill = (int64_t)ring_readable(s->rb);
    room = (int64_t)s->attr.tlength - fill;
    if (room < 0)
        room = 0;
    if ((size_t)room < room_ring)
        room_ring = (size_t)room;
    if (fs)
        room_ring -= room_ring % fs;
    return room_ring;
}

SHIM_EXPORT
int
pa_stream_write(pa_stream *s, const void *data, size_t nbytes,
                pa_free_cb_t free_cb, int64_t offset, pa_seek_mode_t seek)
{
    size_t n;

    (void)offset;
    (void)seek;
    shim_api_hot("pa_stream_write");
    if (!s->rb || !data)
        return -1;
    n = ring_write(s->rb, data, nbytes);
    s->timing.write_index += (int64_t)n;
    {
        static int writes;

        if (writes < 8) {
            shim_log("write %zu -> %zu queued=%zu paused=%d pcm=%d\n", nbytes, n,
                     ring_readable(s->rb), s->paused, s->pcm != NULL);
            writes++;
        }
    }
    shim_stream_maybe_yield(s);
    if (n > 0) {
        if (s->pcm && !s->paused)
            shim_stream_set_output(s, 1);
        else if (!s->pcm && s->want_running) {
            if (shim_stream_acquire(s) == 0) {
                s->paused = 0;
                shim_stream_set_output(s, 1);
            } else {
                shim_stream_schedule_acquire(s);
            }
        }
    }
    if (free_cb)
        free_cb((void *)data);
    return 0;
}

SHIM_EXPORT
void
pa_stream_unref(pa_stream *s)
{
    if (!s)
        return;
    shim_api_hot("pa_stream_unref");
    if (s->pcm && s->ref == 1 && !s->release_pending)
        stream_release(s, 0);
    if (--s->ref > 0)
        return;
    if (s->acquire_ev && s->c->api->time_free)
        s->c->api->time_free(s->acquire_ev);
    shim_context_remove_stream(s->c, s);
    pa_context_unref(s->c);
    ring_free(s->rb);
    stream_free_io_bufs(s);
    free(s);
}
