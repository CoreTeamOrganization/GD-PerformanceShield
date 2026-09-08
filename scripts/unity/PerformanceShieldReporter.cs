// GD-PerformanceShield - engine memory, rendering and audio reporter
// ---------------------------------------------------------------------------
// Drop this file anywhere under Assets/ in a Unity project, add the component to
// one object in the first scene, and make a Development Build. It reports the
// engine's own counters to logcat, where GD-PerformanceShield reads them.
//
// Why this exists
// ---------------
// Android accounts memory by mapping. Unity's native allocator is one anonymous
// mapping, so the OS can say "134 MB appeared" but never "95 MB of it is
// textures". Only the engine knows how its own bytes divide. The same is true of
// everything else in here and more sharply: no amount of sysfs reading will ever
// produce a draw call count, a triangle count, or the milliseconds the main
// thread spent on a frame. Those are facts about the inside of the process.
//
// ProfilerRecorder is Unity's documented API for asking, and it is the only way
// to get these numbers that is accurate on every engine version - the
// PlayerConnection profiler stream carries an internal frame format that changes
// between releases.
//
// Three channels, because they answer different questions and a reader of the
// log should be able to tell them apart:
//
//   OOMI/MEM   allocation totals by asset type      -> why memory grew
//   OOMI/GFX   draw calls, geometry, thread times   -> what limited the frame
//   OOMI/SND   voices and audio-thread CPU          -> why audio crackled
//
// The GFX channel is the one that settles CPU-bound against GPU-bound. Main
// thread, render thread and GPU time are the only figures that can, and nothing
// outside the process can see them - which is why a run without this component
// can only infer a bottleneck from five-second CPU samples.
//
// Cost
// ----
// Around thirty counter reads and three Debug.Log calls per interval (default
// 1 s). The recorders are always-on engine counters, so reading them costs
// essentially nothing; the three log lines total under a kilobyte. Safe to leave
// in a QA build.
//
// Requires Unity 2020.2+ (ProfilerRecorder). Compiled only into development
// builds, so it cannot ship to players by accident.

using System.Collections.Generic;
using System.Text;
using UnityEngine;

#if ENABLE_PROFILER
using Unity.Profiling;
#endif

namespace GDPerformanceShield
{
    [DisallowMultipleComponent]
    public sealed class PerformanceShieldReporter : MonoBehaviour
    {
        [Tooltip("Seconds between reports. The tool samples deep memory every 5 s, " +
                 "so anything faster than that adds log noise without adding detail.")]
        [Range(0.25f, 30f)]
        public float IntervalSeconds = 1f;

        [Tooltip("Keep reporting when the game loses focus. Off by default: a " +
                 "backgrounded game is not what is being profiled.")]
        public bool ReportWhileUnfocused = false;

        // These three tags are a wire format, not branding. They are shared with
        // every game project that already has this component committed, and the
        // reader matches on them literally, so they keep their original spelling
        // through the rename. Changing one silently drops engine metrics for any
        // project still on an older copy of this file.
        const string MemoryTag = "OOMI/MEM";
        const string RenderTag = "OOMI/GFX";
        const string AudioTag = "OOMI/SND";

#if ENABLE_PROFILER
        // Short key -> counter, in the order they are written.
        //
        // Counter availability varies by engine version and platform, so each is
        // probed and the unavailable ones are reported by name rather than sent
        // as a zero. A zero that means "not measured" would read as "no textures",
        // which is worse than an admitted gap.
        static readonly (string Key, ProfilerCategory Category, string Counter)[] MemoryCounters =
        {
            ("tex",         ProfilerCategory.Memory, "Texture Memory"),
            ("mesh",        ProfilerCategory.Memory, "Mesh Memory"),
            ("audio",       ProfilerCategory.Audio,  "Audio Total Memory"),
            ("shader",      ProfilerCategory.Memory, "Material Memory"),
            ("anim",        ProfilerCategory.Memory, "AnimationClip Memory"),
            ("gcUsed",      ProfilerCategory.Memory, "GC Used Memory"),
            ("gcReserved",  ProfilerCategory.Memory, "GC Reserved Memory"),
            ("totalUsed",   ProfilerCategory.Memory, "Total Used Memory"),
            ("totalReserved", ProfilerCategory.Memory, "Total Reserved Memory"),
            ("gfx",         ProfilerCategory.Memory, "Gfx Used Memory"),
        };

        // Rendering work per frame, plus the three stage times.
        //
        // The stage times are nanoseconds, not bytes, and are converted below.
        // They are the reason this channel exists: whichever of main thread,
        // render thread and GPU is closest to the frame interval is the one
        // holding the frame up, and no measurement outside the process can say.
        static readonly (string Key, ProfilerCategory Category, string Counter)[] RenderCounters =
        {
            ("dc",      ProfilerCategory.Render, "Draw Calls Count"),
            ("batch",   ProfilerCategory.Render, "Batches Count"),
            ("sp",      ProfilerCategory.Render, "SetPass Calls Count"),
            ("tri",     ProfilerCategory.Render, "Triangles Count"),
            ("vert",    ProfilerCategory.Render, "Vertices Count"),
            ("shadow",  ProfilerCategory.Render, "Shadow Casters Count"),
            ("texN",    ProfilerCategory.Render, "Used Textures Count"),
            ("texB",    ProfilerCategory.Render, "Used Textures Bytes"),
            ("rtN",     ProfilerCategory.Render, "Render Textures Count"),
            ("rtB",     ProfilerCategory.Render, "Render Textures Bytes"),
            ("vbB",     ProfilerCategory.Render, "Vertex Buffer Upload In Frame Bytes"),
        };

        // Nanosecond timings, reported as milliseconds with one decimal.
        static readonly (string Key, ProfilerCategory Category, string Counter)[] TimeCounters =
        {
            ("main",   ProfilerCategory.Internal, "Main Thread"),
            ("render", ProfilerCategory.Internal, "Render Thread"),
            ("gpu",    ProfilerCategory.Render,   "GPU Frame Time"),
        };

        // Audio. The CPU counters are percentages, which ProfilerRecorder
        // reports scaled - handled below in the same way as the timings.
        static readonly (string Key, ProfilerCategory Category, string Counter)[] AudioCounters =
        {
            ("playing", ProfilerCategory.Audio, "Playing Audio Sources"),
            ("paused",  ProfilerCategory.Audio, "Paused Audio Sources"),
            ("voices",  ProfilerCategory.Audio, "Audio Voices"),
            ("clips",   ProfilerCategory.Audio, "Audio Clip Count"),
            ("mem",     ProfilerCategory.Audio, "Audio Total Memory"),
        };

        static readonly (string Key, ProfilerCategory Category, string Counter)[] AudioCpuCounters =
        {
            ("cpu",    ProfilerCategory.Audio, "Total Audio CPU"),
            ("dsp",    ProfilerCategory.Audio, "DSP CPU"),
            ("stream", ProfilerCategory.Audio, "Streaming CPU"),
            ("other",  ProfilerCategory.Audio, "Other CPU"),
        };

        readonly List<(string Key, ProfilerRecorder Recorder)> _memory = new();
        readonly List<(string Key, ProfilerRecorder Recorder)> _render = new();
        readonly List<(string Key, ProfilerRecorder Recorder)> _times = new();
        readonly List<(string Key, ProfilerRecorder Recorder)> _audio = new();
        readonly List<(string Key, ProfilerRecorder Recorder)> _audioCpu = new();
        readonly List<string> _unavailable = new();
        readonly StringBuilder _line = new(384);
        float _next;

        void OnEnable()
        {
            Start(MemoryCounters, _memory);
            Start(RenderCounters, _render);
            Start(TimeCounters, _times);
            Start(AudioCounters, _audio);
            Start(AudioCpuCounters, _audioCpu);

            var live = _memory.Count + _render.Count + _times.Count + _audio.Count + _audioCpu.Count;
            Debug.Log($"{MemoryTag}/INIT {{\"counters\":{live},\"engine\":\"{Application.unityVersion}\"}}");
        }

        void Start(
            (string Key, ProfilerCategory Category, string Counter)[] wanted,
            List<(string Key, ProfilerRecorder Recorder)> into)
        {
            foreach (var (key, category, counter) in wanted)
            {
                var recorder = ProfilerRecorder.StartNew(category, counter);
                if (recorder.Valid)
                {
                    into.Add((key, recorder));
                }
                else
                {
                    // This engine version does not expose it. Say so once, by
                    // name, so the gap is visible in the report rather than
                    // silently absent.
                    recorder.Dispose();
                    _unavailable.Add(counter);
                }
            }
        }

        void OnDisable()
        {
            foreach (var list in new[] { _memory, _render, _times, _audio, _audioCpu })
            {
                foreach (var (_, recorder) in list) recorder.Dispose();
                list.Clear();
            }
            _unavailable.Clear();
        }

        void Update()
        {
            if (!ReportWhileUnfocused && !Application.isFocused) return;
            if (Time.unscaledTime < _next) return;
            _next = Time.unscaledTime + IntervalSeconds;

            // Memory: raw byte counters.
            Emit(MemoryTag, _memory, null, withUnavailable: true);

            // Rendering: the per-frame counts, plus the three stage times in
            // milliseconds. Sent on one line because the reader has to compare
            // them against each other and against the same frame.
            Emit(RenderTag, _render, _times, withUnavailable: false);

            // Audio: counts as they are, CPU shares as percentages.
            Emit(AudioTag, _audio, _audioCpu, withUnavailable: false, scaleSecond: 1f);
        }

        /// <summary>
        /// Write one tagged line.
        /// </summary>
        /// <param name="scaled">
        /// A second group whose values need converting. Null for none. Timings
        /// arrive in nanoseconds and are divided to milliseconds; audio CPU
        /// arrives already as a percentage, so <paramref name="scaleSecond"/>
        /// leaves it alone.
        /// </param>
        void Emit(
            string tag,
            List<(string Key, ProfilerRecorder Recorder)> raw,
            List<(string Key, ProfilerRecorder Recorder)> scaled,
            bool withUnavailable,
            float scaleSecond = 0f)
        {
            // Nothing to say beats an empty payload the reader has to reject.
            if (raw.Count == 0 && (scaled == null || scaled.Count == 0)) return;

            _line.Clear();
            _line.Append(tag).Append(" {\"ms\":").Append((long)(Time.realtimeSinceStartup * 1000f));

            foreach (var (key, recorder) in raw)
            {
                // LastValue is the counter's most recent sample.
                _line.Append(",\"").Append(key).Append("\":").Append(recorder.LastValue);
            }

            if (scaled != null)
            {
                foreach (var (key, recorder) in scaled)
                {
                    var value = scaleSecond > 0f
                        // Already a percentage: pass it through.
                        ? recorder.LastValue * scaleSecond
                        // Nanoseconds to milliseconds.
                        : recorder.LastValue / 1e6f;
                    _line.Append(",\"").Append(key).Append("\":").Append(value.ToString("0.0#",
                        System.Globalization.CultureInfo.InvariantCulture));
                }
            }

            // Listed once, on the memory line, so a reader is told what this
            // engine version could not supply without it being repeated three
            // times a second.
            if (withUnavailable && _unavailable.Count > 0)
            {
                _line.Append(",\"na\":[");
                for (var i = 0; i < _unavailable.Count; i++)
                {
                    if (i > 0) _line.Append(',');
                    _line.Append('"').Append(_unavailable[i]).Append('"');
                }
                _line.Append(']');
            }

            _line.Append('}');
            Debug.Log(_line.ToString());
        }
#else
        void OnEnable()
        {
            // A release build has no profiler counters at all. Saying so beats
            // reporting nothing and leaving the operator to wonder.
            Debug.Log($"{MemoryTag}/INIT {{\"counters\":0,\"reason\":\"not a development build\"}}");
            enabled = false;
        }
#endif
    }
}
