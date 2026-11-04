#include "../src/stream.c"

#include <inttypes.h>
#include <sched.h>

static snd_pcm_sframes_t pcm_delay;
static snd_pcm_sframes_t pcm_avail = 1024;
static snd_pcm_state_t pcm_state = SND_PCM_STATE_RUNNING;
static int delay_error;
static unsigned delay_calls;
static unsigned prepare_calls;
static unsigned drop_calls;
static unsigned underflows;
static unsigned checks;
static unsigned failures;
static unsigned char pcm_token;

int __wrap_snd_pcm_delay(snd_pcm_t *pcm, snd_pcm_sframes_t *delay)
{
    (void)pcm;
    delay_calls++;
    *delay = pcm_delay;
    return delay_error;
}

snd_pcm_sframes_t
__wrap_snd_pcm_avail(snd_pcm_t *pcm)
{
    (void)pcm;
    return pcm_avail;
}

snd_pcm_state_t
__wrap_snd_pcm_state(snd_pcm_t *pcm)
{
    (void)pcm;
    return pcm_state;
}

int __wrap_snd_pcm_prepare(snd_pcm_t *pcm)
{
    (void)pcm;
    prepare_calls++;
    pcm_state = SND_PCM_STATE_PREPARED;
    pcm_delay = 0;
    delay_error = 0;
    return 0;
}

snd_pcm_sframes_t
__wrap_snd_pcm_writei(snd_pcm_t *pcm, const void *buffer,
                      snd_pcm_uframes_t frames)
{
    (void)pcm;
    (void)buffer;
    return (snd_pcm_sframes_t)frames;
}

int __wrap_snd_pcm_nonblock(snd_pcm_t *pcm, int nonblock)
{
    (void)pcm;
    (void)nonblock;
    return 0;
}

int __wrap_snd_pcm_drop(snd_pcm_t *pcm)
{
    (void)pcm;
    __sync_fetch_and_add(&drop_calls, 1);
    return 0;
}

int __wrap_snd_pcm_close(snd_pcm_t *pcm)
{
    (void)pcm;
    return 0;
}

static void
check(const char *name, int64_t actual, int64_t expected)
{
    checks++;
    if (actual == expected)
        return;
    if (failures++ < 12)
        fprintf(stderr, "FAIL %s: got %" PRId64 ", expected %" PRId64 "\n",
                name, actual, expected);
}

static pa_stream *
new_stream(pa_context *context, pa_sample_format_t format, unsigned rate,
           unsigned channels)
{
    pa_sample_spec spec = {format, rate, (uint8_t)channels};
    pa_stream *stream = pa_stream_new(context, "timing", &spec, NULL);

    stream->state = PA_STREAM_READY;
    stream->pcm = (snd_pcm_t *)&pcm_token;
    stream->paused = 0;
    stream_clock_start(stream);
    pcm_delay = 0;
    delay_error = 0;
    pcm_avail = 1024;
    pcm_state = SND_PCM_STATE_RUNNING;
    return stream;
}

static void
free_stream(pa_stream *stream)
{
    stream->pcm = NULL;
    pa_stream_unref(stream);
    while (__sync_fetch_and_add(&pcm_closes_in_flight, 0))
        sched_yield();
}

static void
completion_cases(pa_context *context)
{
    static const pa_sample_format_t formats[] = {
        PA_SAMPLE_S16LE, PA_SAMPLE_S16BE, PA_SAMPLE_FLOAT32LE,
        PA_SAMPLE_FLOAT32BE, PA_SAMPLE_S32LE, PA_SAMPLE_S32BE,
        PA_SAMPLE_S24LE, PA_SAMPLE_S24BE, PA_SAMPLE_S24_32LE,
        PA_SAMPLE_S24_32BE};
    static const unsigned rates[] = {8000, 22050, 44100, 48000, 88200, 96000, 192000};
    static const unsigned channels[] = {1, 2, 6};
    size_t format_index, rate_index, channel_index;
    unsigned frame;

    for (format_index = 0; format_index < sizeof(formats) / sizeof(formats[0]); format_index++)
        for (rate_index = 0; rate_index < sizeof(rates) / sizeof(rates[0]); rate_index++)
            for (channel_index = 0; channel_index < sizeof(channels) / sizeof(channels[0]); channel_index++)
            {
                pa_stream *stream = new_stream(context, formats[format_index],
                                               rates[rate_index], channels[channel_index]);
                size_t frame_size = shim_frame_size(&stream->ss);

                for (frame = 1; frame <= 1000; frame++)
                {
                    stream->timing.write_index = (int64_t)frame * (int64_t)frame_size;
                    shim_stream_update_timing(stream);
                    check("fully played frame", stream->timing.read_index,
                          stream->timing.write_index);
                }
                free_stream(stream);
            }
}

static void
underflow(pa_stream *stream, void *userdata)
{
    (void)stream;
    (void)userdata;
    underflows++;
}

static void
run_operation(pa_stream *stream, void (*run)(pa_operation *), uint32_t value)
{
    pa_operation *operation = shim_op_new(stream->c->api, run);

    operation->s = stream;
    operation->idx = value;
    run(operation);
}

static void
lifecycle_cases(pa_context *context)
{
    pa_stream *stream = new_stream(context, PA_SAMPLE_FLOAT32LE, 48000, 2);
    const int64_t second = 48000 * 8;
    float samples[16] = {0};
    unsigned calls;

    stream->timing.write_index = second;
    pcm_delay = 480;
    check("ring write", ring_write(stream->rb, samples, sizeof(samples)), sizeof(samples));
    shim_stream_update_timing(stream);
    check("ring and ALSA queued", stream->timing.read_index, second - 480 * 8 - sizeof(samples));
    pcm_delay = 960;
    shim_stream_update_timing(stream);
    check("delay growth is monotonic", stream->timing.read_index, second - 480 * 8 - sizeof(samples));
    ring_drop(stream->rb, sizeof(samples));
    pcm_delay = 0;
    shim_stream_update_timing(stream);
    check("drained", stream->timing.read_index, second);
    pa_stream_set_underflow_callback(stream, underflow, NULL);
    shim_stream_update_timing(stream);
    check("no new underflow callback", underflows, 0);

    run_operation(stream, cork_run, 1);
    calls = delay_calls;
    stream->timing.write_index += second;
    shim_stream_update_timing(stream);
    check("cork freezes position", stream->timing.read_index, second);
    check("cork does not sample delay", delay_calls, calls);
    run_operation(stream, cork_run, 0);
    shim_stream_update_timing(stream);
    check("uncork resumes", stream->timing.read_index, 2 * second);

    check("ring write before flush", ring_write(stream->rb, samples, sizeof(samples)), sizeof(samples));
    calls = prepare_calls;
    run_operation(stream, flush_run, 0);
    check("flush clears ring", ring_readable(stream->rb), 0);
    check("flush clears write index", stream->timing.write_index, 0);
    check("flush clears read index", stream->timing.read_index, 0);
    check("healthy flush does not prepare", prepare_calls, calls);
    check("healthy flush does not drop", drop_calls, 0);
    stream->timing.write_index = second;
    shim_stream_update_timing(stream);
    check("flush clock remains frozen", stream->timing.read_index, 0);
    stream_clock_start(stream);
    pcm_delay = 24000;
    shim_stream_update_timing(stream);
    check("new epoch subtracts remaining ALSA delay", stream->timing.read_index, second / 2);

    calls = prepare_calls;
    check("xrun prepares", stream_prepare(stream), 0);
    check("one prepare", prepare_calls, calls + 1);
    pcm_delay = 0;
    shim_stream_update_timing(stream);
    check("xrun holds position", stream->timing.read_index, second / 2);
    stream_clock_start(stream);
    shim_stream_update_timing(stream);
    check("recovery advances", stream->timing.read_index, second);

    pcm_delay = -1;
    shim_stream_update_timing(stream);
    check("negative delay does not exceed writes", stream->timing.read_index, second);
    delay_error = -EIO;
    shim_stream_update_timing(stream);
    check("delay error preserves existing policy", stream->timing.read_index, second);
    delay_error = 0;
    pcm_delay = 0;

    setenv("APULSE_YIELD_PATH", "/dev/null", 1);
    shim_stream_update_timing(stream);
    check("yield releases PCM", stream->pcm != NULL, 0);
    check("yield holds write position", stream->timing.write_index, second);
    check("yield holds read position", stream->timing.read_index, second);
    check("yield clock is stopped", stream->clock_running, 0);
    setenv("APULSE_YIELD_PATH", "/nonexistent/soloist-test-yield", 1);
    stream->pcm = (snd_pcm_t *)&pcm_token;
    stream_clock_start(stream);
    shim_stream_update_timing(stream);
    check("reclaim keeps held position", stream->timing.read_index, second);
    free_stream(stream);
}

static void
precision_cases(pa_context *context)
{
    static const unsigned rates[] = {44100, 48000, 96000};
    static const pa_sample_format_t formats[] = {PA_SAMPLE_FLOAT32LE, PA_SAMPLE_S16LE};
    size_t rate_index, format_index;

    for (rate_index = 0; rate_index < sizeof(rates) / sizeof(rates[0]); rate_index++)
        for (format_index = 0; format_index < sizeof(formats) / sizeof(formats[0]); format_index++)
        {
            pa_stream *stream = new_stream(context, formats[format_index], rates[rate_index], 2);
            size_t frame_size = shim_frame_size(&stream->ss);
            int64_t end = ((int64_t)rates[rate_index] * 251 + 1) * (int64_t)frame_size;
            int64_t held;
            char samples[64] = {0};
            unsigned calls;

            stream->timing.write_index = end;
            pcm_delay = 1;
            pcm_state = SND_PCM_STATE_PREPARED;
            shim_stream_update_timing(stream);
            check("PREPARED with positive delay is not drained", stream->timing.read_index, end - (int64_t)frame_size);
            pcm_delay = 0;
            shim_stream_update_timing(stream);
            check("nonintegral time reaches exact end", stream->timing.read_index, end);
            run_operation(stream, cork_run, 1);
            stream->timing.write_index += (int64_t)frame_size;
            shim_stream_update_timing(stream);
            check("cork retains exact final frame", stream->timing.read_index, end);
            run_operation(stream, cork_run, 0);
            shim_stream_update_timing(stream);
            check("uncork advances one frame", stream->timing.read_index, end + (int64_t)frame_size);

            run_operation(stream, flush_run, 0);
            check("precision flush resets clock", stream_played_bytes(stream), 0);
            stream->timing.write_index = end;
            check("precision ring write", ring_write(stream->rb, samples, sizeof(samples)), sizeof(samples));
            stream_clock_start(stream);
            pcm_delay = 7;
            shim_stream_update_timing(stream);
            held = end - 7 * (int64_t)frame_size - sizeof(samples);
            check("precision queued position", stream->timing.read_index, held);
            setenv("APULSE_YIELD_PATH", "/dev/null", 1);
            shim_stream_update_timing(stream);
            check("yield does not count discarded ring", stream->timing.read_index, held);
            check("yield rebases writes to exact played bytes", stream->timing.write_index, held);
            check("yield discards ring", ring_readable(stream->rb), 0);
            setenv("APULSE_YIELD_PATH", "/nonexistent/soloist-test-yield", 1);
            while (__sync_fetch_and_add(&pcm_closes_in_flight, 0))
                sched_yield();
            stream->pcm = (snd_pcm_t *)&pcm_token;
            pcm_delay = 0;
            run_operation(stream, cork_run, 0);
            pa_stream_write(stream, samples, sizeof(samples), NULL, 0, PA_SEEK_RELATIVE);
            shim_stream_update_timing(stream);
            check("reclaim does not play newly queued bytes", stream->timing.read_index, held);
            ring_drop(stream->rb, sizeof(samples));
            shim_stream_update_timing(stream);
            check("reclaim completes new writes exactly", stream->timing.read_index, held + sizeof(samples));

            run_operation(stream, flush_run, 0);
            stream->timing.write_index = ((INT64_C(1) << 32) / (int64_t)frame_size + 1) * (int64_t)frame_size;
            stream_clock_start(stream);
            shim_stream_update_timing(stream);
            check("position beyond 4 GiB", stream->timing.read_index, stream->timing.write_index);
            stream_clock_freeze(stream);
            stream_clock_hold(stream);
            check("held position beyond 4 GiB", stream->timing.read_index, stream->timing.write_index);
            check("hold retains 64-bit position", stream->timing.read_index > UINT32_MAX, 1);

            run_operation(stream, flush_run, 0);
            stream->timing.write_index = (int64_t)frame_size;
            stream_clock_start(stream);
            pcm_delay = 100;
            shim_stream_update_timing(stream);
            check("delay exceeding writes clamps to zero", stream->timing.read_index, 0);
            pcm_delay = 0;
            check("new epoch ring write", ring_write(stream->rb, samples, sizeof(samples)), sizeof(samples));
            calls = delay_calls;
            stream_clock_freeze(stream);
            shim_stream_update_timing(stream);
            check("frozen clock does not consume queued audio", stream->timing.read_index, 0);
            check("frozen clock does not query ALSA", delay_calls, calls);
            stream->alsa_fmt = client_format(stream->ss.format);
            stream->alsa_fs = shim_alsa_frame_size(stream->alsa_fmt, stream->ss.channels);
            stream->io_buf_bytes = sizeof(samples);
            stream->io_buf = calloc(1, sizeof(samples));
            stream->period = 8;
            pcm_avail = 8;
            pcm_state = SND_PCM_STATE_RUNNING;
            while (ring_readable(stream->rb))
                io_cb(context->api, NULL, -1, PA_IO_EVENT_OUTPUT, stream);
            shim_stream_update_timing(stream);
            check("successful write restarts frozen clock", stream->clock_running, 1);
            check("new epoch stays bounded by writes", stream->timing.read_index, stream->timing.write_index);
            pa_stream_set_underflow_callback(stream, underflow, NULL);
            calls = underflows;
            pcm_avail = -EIO;
            check("dead prepare fails", stream_prepare(stream), -1);
            check("dead prepare preserves underflow callback", underflows, calls + 1);
            check("dead prepare marks unsafe handle", stream->drop_unsafe, 1);
            check("disconnect succeeds", pa_stream_disconnect(stream), 0);
            check("disconnect clears indices", stream->timing.read_index + stream->timing.write_index, 0);
            check("disconnect terminates", pa_stream_get_state(stream), PA_STREAM_TERMINATED);
            free_stream(stream);
        }
}

static void
drain_cases(pa_context *context)
{
    static const unsigned rates[] = {44100, 48000, 96000};
    static const pa_sample_format_t formats[] = {PA_SAMPLE_FLOAT32LE, PA_SAMPLE_S16LE};
    size_t rate_index, format_index;
    unsigned scenario;

    for (rate_index = 0; rate_index < sizeof(rates) / sizeof(rates[0]); rate_index++)
        for (format_index = 0; format_index < sizeof(formats) / sizeof(formats[0]); format_index++)
            for (scenario = 0; scenario < 6; scenario++)
            {
                pa_stream *stream = new_stream(context, formats[format_index], rates[rate_index], 2);
                size_t frame_size = shim_frame_size(&stream->ss);
                char samples[64] = {0};
                int64_t end = ((int64_t)rates[rate_index] + 1) * (int64_t)frame_size;
                int64_t expected;

                stream->timing.write_index = end;
                if (scenario == 1)
                    check("queued recovery setup", ring_write(stream->rb, samples, sizeof(samples)), sizeof(samples));
                pcm_delay = 1;
                shim_stream_update_timing(stream);
                expected = stream->timing.read_index;
                pcm_state = SND_PCM_STATE_XRUN;
                delay_error = -EPIPE;
                if (scenario == 0)
                    expected = end;
                else if (scenario == 1)
                    expected = end - sizeof(samples);
                else if (scenario == 2)
                    run_operation(stream, cork_run, 1);
                else if (scenario == 3)
                    pcm_state = SND_PCM_STATE_RUNNING;
                else if (scenario == 4)
                {
                    run_operation(stream, flush_run, 0);
                    stream->timing.write_index = end;
                    pcm_state = SND_PCM_STATE_XRUN;
                    expected = 0;
                }
                else
                {
                    pcm_state = SND_PCM_STATE_XRUN;
                    delay_error = 0;
                    pcm_delay = 1;
                }

                check("recovery succeeds", stream_prepare(stream), 0);
                check("recovery produces PREPARED", pcm_state, SND_PCM_STATE_PREPARED);
                check("recovery freezes clock", stream->clock_running, 0);
                shim_stream_update_timing(stream);
                check(scenario == 0 ? "drained PREPARED reaches exact end" : scenario == 1 ? "recovery credits only submitted audio"
                                                                         : scenario == 2   ? "paused recovery does not advance"
                                                                         : scenario == 3   ? "non-XRUN recovery does not invent completion"
                                                                         : scenario == 4   ? "post-flush recovery does not credit new writes"
                                                                                           : "positive delay is not credited as drained",
                      stream->timing.read_index, expected);
                check("recovery preserves ring", ring_readable(stream->rb), scenario == 1 ? sizeof(samples) : 0);
                shim_stream_update_timing(stream);
                check("repeated timing stays stable", stream->timing.read_index, expected);
                free_stream(stream);
            }
}

int main(int argc, char **argv)
{
    pa_threaded_mainloop *mainloop = pa_threaded_mainloop_new();
    pa_context *context = pa_context_new(pa_threaded_mainloop_get_api(mainloop), "timing-test");

    setenv("APULSE_YIELD_PATH", "/nonexistent/soloist-test-yield", 1);
    if (argc == 2 && strcmp(argv[1], "completion") == 0)
        completion_cases(context);
    else if (argc == 2 && strcmp(argv[1], "lifecycle") == 0)
        lifecycle_cases(context);
    else if (argc == 2 && strcmp(argv[1], "precision") == 0)
        precision_cases(context);
    else if (argc == 2 && strcmp(argv[1], "drain") == 0)
        drain_cases(context);
    else
        return 2;
    pa_context_unref(context);
    pa_threaded_mainloop_free(mainloop);
    printf("%s: %u checks, %u failures\n", argv[1], checks, failures);
    return failures ? 1 : 0;
}