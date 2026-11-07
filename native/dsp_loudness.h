#ifndef OURMUSIC_DSP_LOUDNESS_H
#define OURMUSIC_DSP_LOUDNESS_H

#include "audio_formats.h"

typedef struct {
    double integrated_lufs;   /* ITU-R BS.1770-4 / EBU R128 gated integrated loudness (LUFS) */
    double loudness_range_lu; /* Approximate LRA / dynamic spread in LU */
    double sample_peak;       /* Maximum linear sample peak [0.0 .. +inf) */
    double true_peak;         /* 4x Hermite-interpolated inter-sample true peak */
    double peak_db;           /* 20 * log10(true_peak) in dBFS */
    double replaygain_db;     /* ReplayGain 2.0 gain adjustment relative to -18.0 LUFS */
    double r128_gain_db;      /* EBU R128 gain adjustment relative to -23.0 LUFS */
} om_loudness_result_t;

/* Scan any supported local audio file (FLAC, ALAC, WAV, MP3, DSD) at full CPU speed */
int om_loudness_scan_file(const char *path, om_loudness_result_t *out, char *err, size_t err_cap);

#endif /* OURMUSIC_DSP_LOUDNESS_H */
