#include "audio_formats.h"
#include "dec_mp3_tables.h"
#include "dec_mp3_huff.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define MP3_RESERVOIR_CAP 8192

typedef struct {
    int16_t left;   /* >=0 child node index, <0 leaf: -(sym + 1) */
    int16_t right;
} mp3_trie_node_t;

typedef struct {
    uint32_t part2_3_length;
    uint32_t big_values;
    uint32_t global_gain;
    uint32_t scalefac_compress;
    uint32_t window_switching;
    uint32_t block_type;
    uint32_t mixed_block_flag;
    uint32_t table_select[3];
    uint32_t subblock_gain[3];
    uint32_t region0_count;
    uint32_t region1_count;
    uint32_t preflag;
    uint32_t scalefac_scale;
    uint32_t count1table_select;
} mp3_gran_ch_t;

typedef struct {
    FILE    *fp;
    uint64_t audio_start_off;
    uint64_t audio_end_off;
    uint64_t frames_emitted;
    uint32_t skip_lead_frames; /* LAME enc_delay + 528 decoder delay */
    uint32_t skip_remaining;
    bool     has_toc;
    uint8_t  xing_toc[100];

    /* Bit reservoir */
    uint8_t  reservoir[MP3_RESERVOIR_CAP];
    size_t   res_len;

    /* Synthesis filterbank & IMDCT overlap state */
    double   prev_blck[2][32][18];
    double   synth_v[2][1024];
    int      synth_off[2];

    /* Decoded PCM staging (up to 1152 frames per MP3 frame) */
    double   out_pcm[1152 * 2];
    uint32_t pcm_avail;
    uint32_t pcm_pos;
} mp3_priv_t;

/* Global read-only tables initialized once */
static bool            g_mp3_tables_ready = false;
static mp3_trie_node_t g_huff_pool[8192];
static int             g_huff_roots[32];
static int             g_count1a_root = -1;
static double          g_pow43[8208];
static double          g_alias_cs[8];
static double          g_alias_ca[8];
static double          g_imdct_win[4][36];
static double          g_cos_imdct36[18][36];
static double          g_cos_imdct12[6][12];
static double          g_synth_cos[64][32];

static int build_trie(const mp3_huff_sym_t *syms, uint16_t count, int *pool_used) {
    if (!syms || count == 0) return -1;
    int root = (*pool_used)++;
    g_huff_pool[root].left = -1;
    g_huff_pool[root].right = -1;

    for (uint16_t i = 0; i < count; i++) {
        int cur = root;
        uint8_t len = syms[i].len;
        uint32_t code = syms[i].code;
        for (int b = len - 1; b >= 0; b--) {
            int bit = (int)((code >> b) & 1U);
            int16_t *edge = bit ? &g_huff_pool[cur].right : &g_huff_pool[cur].left;
            if (b == 0) {
                *edge = (int16_t)(-(int)syms[i].sym - 1);
            } else {
                if (*edge < 0) {
                    int nxt = (*pool_used)++;
                    g_huff_pool[nxt].left = -1;
                    g_huff_pool[nxt].right = -1;
                    *edge = (int16_t)nxt;
                }
                cur = *edge;
            }
        }
    }
    return root;
}

static void mp3_init_global_tables(void) {
    if (g_mp3_tables_ready) return;

    int used = 0;
    for (int t = 0; t < 32; t++) {
        g_huff_roots[t] = build_trie(mp3_huff_books[t].entries, mp3_huff_books[t].count, &used);
    }
    g_count1a_root = build_trie(mp3_ht_count1a, 16, &used);

    for (int i = 0; i < 8208; i++) {
        g_pow43[i] = pow((double)i, 4.0 / 3.0);
    }

    static const double ci[8] = {
        -0.6, -0.535, -0.33, -0.185, -0.095, -0.041, -0.0142, -0.0037
    };
    for (int i = 0; i < 8; i++) {
        double sq = sqrt(1.0 + ci[i] * ci[i]);
        g_alias_cs[i] = 1.0 / sq;
        g_alias_ca[i] = ci[i] / sq;
    }

    /* Block type windows per ISO 11172-3 2.4.3.4.10.3 */
    for (int i = 0; i < 36; i++) {
        g_imdct_win[0][i] = sin(M_PI / 36.0 * ((double)i + 0.5));
    }
    for (int i = 0; i < 18; i++) g_imdct_win[1][i] = sin(M_PI / 36.0 * ((double)i + 0.5));
    for (int i = 18; i < 24; i++) g_imdct_win[1][i] = 1.0;
    for (int i = 24; i < 30; i++) g_imdct_win[1][i] = sin(M_PI / 12.0 * ((double)(i - 18) + 0.5));
    for (int i = 30; i < 36; i++) g_imdct_win[1][i] = 0.0;

    for (int i = 0; i < 12; i++) g_imdct_win[2][i] = sin(M_PI / 12.0 * ((double)i + 0.5));
    for (int i = 12; i < 36; i++) g_imdct_win[2][i] = 0.0;

    for (int i = 0; i < 6; i++)  g_imdct_win[3][i] = 0.0;
    for (int i = 6; i < 12; i++) g_imdct_win[3][i] = sin(M_PI / 12.0 * ((double)(i - 6) + 0.5));
    for (int i = 12; i < 18; i++) g_imdct_win[3][i] = 1.0;
    for (int i = 18; i < 36; i++) g_imdct_win[3][i] = sin(M_PI / 36.0 * ((double)i + 0.5));

    for (int k = 0; k < 18; k++) {
        for (int i = 0; i < 36; i++) {
            g_cos_imdct36[k][i] = cos(M_PI / 72.0 * (double)(2 * i + 1 + 18) * (double)(2 * k + 1));
        }
    }
    for (int k = 0; k < 6; k++) {
        for (int i = 0; i < 12; i++) {
            g_cos_imdct12[k][i] = cos(M_PI / 24.0 * (double)(2 * i + 1 + 6) * (double)(2 * k + 1));
        }
    }
    for (int i = 0; i < 64; i++) {
        for (int k = 0; k < 32; k++) {
            g_synth_cos[i][k] = cos((double)(16 + i) * (double)(2 * k + 1) * (M_PI / 64.0));
        }
    }

    g_mp3_tables_ready = true;
}

typedef struct {
    const uint8_t *buf;
    size_t         bit_pos;
    size_t         bit_end;
} mp3_br_t;

static inline uint32_t mp3_br_get1(mp3_br_t *br) {
    if (br->bit_pos >= br->bit_end) {
        br->bit_pos++;
        return 0;
    }
    uint32_t v = (br->buf[br->bit_pos >> 3] >> (7 - (br->bit_pos & 7U))) & 1U;
    br->bit_pos++;
    return v;
}

static inline uint32_t mp3_br_get(mp3_br_t *br, int n) {
    uint32_t v = 0;
    for (int i = 0; i < n; i++) {
        v = (v << 1) | mp3_br_get1(br);
    }
    return v;
}

static inline int mp3_huff_decode_sym(mp3_br_t *br, int root) {
    if (root < 0) return 0;
    int cur = root;
    while (cur >= 0) {
        uint32_t bit = mp3_br_get1(br);
        cur = bit ? g_huff_pool[cur].right : g_huff_pool[cur].left;
    }
    return (-cur) - 1;
}

typedef struct {
    int      ver_id;       /* 3=MPEG1, 2=MPEG2, 0=MPEG2.5 */
    bool     is_mpeg1;
    bool     has_crc;
    uint32_t bitrate_kbps;
    uint32_t sample_rate;
    uint8_t  sr_idx;
    uint8_t  padding;
    uint8_t  mode;         /* 0=stereo, 1=joint, 2=dual, 3=mono */
    uint8_t  mode_ext;
    uint16_t channels;
    uint32_t frame_bytes;
    uint32_t sideinfo_bytes;
    int      sfb_table_idx;
} mp3_hdr_t;

static bool mp3_parse_header(const uint8_t h[4], mp3_hdr_t *out) {
    if (h[0] != 0xFFU || (h[1] & 0xE0U) != 0xE0U) return false;
    int ver_id = (h[1] >> 3) & 3;
    int layer_code = (h[1] >> 1) & 3;
    if (ver_id == 1 || layer_code != 1) return false; /* Layer III == 0b01 */

    bool is_mpeg1 = (ver_id == 3);
    int br_idx = (h[2] >> 4) & 0x0F;
    int sr_idx = (h[2] >> 2) & 0x03;
    if (br_idx == 0 || br_idx == 15 || sr_idx == 3) return false;

    uint32_t sr = mp3_samplerates[ver_id][sr_idx];
    uint32_t br = mp3_bitrates_l3[is_mpeg1 ? 1 : 0][br_idx];
    if (sr == 0 || br == 0) return false;

    uint8_t padding = (h[2] >> 1) & 1U;
    uint8_t mode = (h[3] >> 6) & 3U;
    uint16_t channels = (mode == 3U) ? 1U : 2U;

    uint32_t frame_bytes = is_mpeg1
        ? ((144000U * br) / sr + padding)
        : ((72000U * br) / sr + padding);
    if (frame_bytes < 24) return false;

    out->ver_id = ver_id;
    out->is_mpeg1 = is_mpeg1;
    out->has_crc = ((h[1] & 1U) == 0);
    out->bitrate_kbps = br;
    out->sample_rate = sr;
    out->sr_idx = (uint8_t)sr_idx;
    out->padding = padding;
    out->mode = mode;
    out->mode_ext = (h[3] >> 4) & 3U;
    out->channels = channels;
    out->frame_bytes = frame_bytes;
    out->sideinfo_bytes = is_mpeg1 ? ((channels == 1) ? 17U : 32U)
                                   : ((channels == 1) ?  9U : 17U);
    out->sfb_table_idx = (ver_id == 3 ? 0 : (ver_id == 2 ? 3 : 6)) + sr_idx;
    return true;
}

static void mp3_synth_32(mp3_priv_t *m, int ch, const double sb_in[32], double *pcm_out, uint16_t stride) {
    int off = (m->synth_off[ch] - 64) & 1023;
    m->synth_off[ch] = off;
    double *v = m->synth_v[ch];

    for (int i = 0; i < 64; i++) {
        double sum = 0.0;
        for (int k = 0; k < 32; k++) {
            sum += g_synth_cos[i][k] * sb_in[k];
        }
        v[off + i] = sum;
    }

    for (int j = 0; j < 32; j++) {
        double sum = 0.0;
        for (int i = 0; i < 16; i += 2) {
            int u0 = (off + j + (i << 6)) & 1023;
            int u1 = (off + j + 32 + ((i + 1) << 6)) & 1023;
            sum += v[u0] * mp3_synth_win[j + (i << 5)];
            sum += v[u1] * mp3_synth_win[j + 32 + (i << 5)];
        }
        if (sum > 1.0) sum = 1.0;
        if (sum < -1.0) sum = -1.0;
        pcm_out[j * stride + ch] = sum;
    }
}

static bool mp3_decode_mpeg_frame(om_decoder_t *dec) {
    mp3_priv_t *m = (mp3_priv_t *)dec->priv;
    uint8_t fbuf[2880];
    mp3_hdr_t hdr;

    /* Find next valid frame sync */
    bool found = false;
    for (int tries = 0; tries < 65536; tries++) {
#ifdef _WIN32
        uint64_t pos = (uint64_t)_ftelli64(m->fp);
#else
        uint64_t pos = (uint64_t)ftello(m->fp);
#endif
        if (pos + 4 > m->audio_end_off) return false;
        if (fread(fbuf, 1, 4, m->fp) != 4) return false;
        if (mp3_parse_header(fbuf, &hdr) && hdr.sample_rate == dec->info.sample_rate && hdr.channels == dec->info.channels) {
            if (hdr.frame_bytes <= sizeof(fbuf)) {
                size_t rem = hdr.frame_bytes - 4U;
                if (fread(fbuf + 4, 1, rem, m->fp) == rem) {
                    found = true;
                    break;
                }
            }
        }
#ifdef _WIN32
        _fseeki64(m->fp, (int64_t)(pos + 1), SEEK_SET);
#else
        fseeko(m->fp, (off_t)(pos + 1), SEEK_SET);
#endif
    }
    if (!found) return false;

    size_t si_off = 4U + (hdr.has_crc ? 2U : 0U);
    if (si_off + hdr.sideinfo_bytes > hdr.frame_bytes) return false;

    mp3_br_t sbr = { fbuf + si_off, 0, hdr.sideinfo_bytes * 8U };
    uint32_t main_data_begin = mp3_br_get(&sbr, hdr.is_mpeg1 ? 9 : 8);
    (void)mp3_br_get(&sbr, hdr.is_mpeg1 ? (hdr.channels == 1 ? 5 : 3) : (hdr.channels == 1 ? 1 : 2));

    uint32_t scfsi[2][4] = {{0}};
    if (hdr.is_mpeg1) {
        for (uint16_t ch = 0; ch < hdr.channels; ch++) {
            for (int b = 0; b < 4; b++) scfsi[ch][b] = mp3_br_get1(&sbr);
        }
    }

    int granules = hdr.is_mpeg1 ? 2 : 1;
    mp3_gran_ch_t gi[2][2];
    memset(gi, 0, sizeof(gi));

    for (int gr = 0; gr < granules; gr++) {
        for (uint16_t ch = 0; ch < hdr.channels; ch++) {
            mp3_gran_ch_t *g = &gi[gr][ch];
            g->part2_3_length    = mp3_br_get(&sbr, 12);
            g->big_values        = mp3_br_get(&sbr, 9);
            g->global_gain       = mp3_br_get(&sbr, 8);
            g->scalefac_compress = mp3_br_get(&sbr, hdr.is_mpeg1 ? 4 : 9);
            g->window_switching  = mp3_br_get1(&sbr);
            if (g->window_switching) {
                g->block_type       = mp3_br_get(&sbr, 2);
                g->mixed_block_flag = mp3_br_get1(&sbr);
                g->table_select[0]  = mp3_br_get(&sbr, 5);
                g->table_select[1]  = mp3_br_get(&sbr, 5);
                g->subblock_gain[0] = mp3_br_get(&sbr, 3);
                g->subblock_gain[1] = mp3_br_get(&sbr, 3);
                g->subblock_gain[2] = mp3_br_get(&sbr, 3);
                g->region0_count    = (g->block_type == 2 && !g->mixed_block_flag) ? 8U : 7U;
                g->region1_count    = 36U;
            } else {
                g->block_type       = 0;
                g->mixed_block_flag = 0;
                g->table_select[0]  = mp3_br_get(&sbr, 5);
                g->table_select[1]  = mp3_br_get(&sbr, 5);
                g->table_select[2]  = mp3_br_get(&sbr, 5);
                g->region0_count    = mp3_br_get(&sbr, 4);
                g->region1_count    = mp3_br_get(&sbr, 3);
            }
            if (hdr.is_mpeg1) g->preflag = mp3_br_get1(&sbr);
            g->scalefac_scale     = mp3_br_get1(&sbr);
            g->count1table_select = mp3_br_get1(&sbr);
        }
    }

    /* Append main_data bytes into bit reservoir */
    size_t md_off = si_off + hdr.sideinfo_bytes;
    size_t md_len = hdr.frame_bytes - md_off;
    size_t prev_res_end = m->res_len;
    if (m->res_len + md_len > MP3_RESERVOIR_CAP) {
        size_t keep = (main_data_begin + 1024U < m->res_len) ? (main_data_begin + 1024U) : m->res_len;
        if (keep + md_len > MP3_RESERVOIR_CAP) keep = MP3_RESERVOIR_CAP - md_len;
        memmove(m->reservoir, m->reservoir + (m->res_len - keep), keep);
        m->res_len = keep;
        prev_res_end = m->res_len;
    }
    memcpy(m->reservoir + m->res_len, fbuf + md_off, md_len);
    m->res_len += md_len;

    if (main_data_begin > prev_res_end) {
        /* Not enough reservoir history yet (e.g. right after seek); silence this frame */
        memset(m->out_pcm, 0, (size_t)granules * 576U * hdr.channels * sizeof(double));
        m->pcm_avail = (uint32_t)granules * 576U;
        m->pcm_pos = 0;
        return true;
    }

    size_t gr_bit_cursor = (prev_res_end - main_data_begin) * 8U;

    /* Compute sfb cumulative index boundaries */
    int sfb_l[23] = {0};
    for (int s = 0; s < 22; s++) {
        sfb_l[s + 1] = sfb_l[s] + mp3_sfb_long_width[hdr.sfb_table_idx][s];
        if (sfb_l[s + 1] > 576) sfb_l[s + 1] = 576;
    }
    sfb_l[22] = 576;

    int sfb_s[14] = {0};
    for (int s = 0; s < 13; s++) {
        sfb_s[s + 1] = sfb_s[s] + mp3_sfb_short_width[hdr.sfb_table_idx][s];
        if (sfb_s[s + 1] > 192) sfb_s[s + 1] = 192;
    }
    sfb_s[13] = 192;

    int scalefac_l[2][22];
    int scalefac_s[2][13][3];
    memset(scalefac_l, 0, sizeof(scalefac_l));
    memset(scalefac_s, 0, sizeof(scalefac_s));

    for (int gr = 0; gr < granules; gr++) {
        double xr[2][576];
        int    is_val[2][576];
        int    rzero_idx[2] = {0, 0};
        memset(xr, 0, sizeof(xr));
        memset(is_val, 0, sizeof(is_val));

        for (uint16_t ch = 0; ch < hdr.channels; ch++) {
            mp3_gran_ch_t *g = &gi[gr][ch];
            size_t p23_start = gr_bit_cursor;
            size_t p23_end   = p23_start + g->part2_3_length;
            gr_bit_cursor    = p23_end;

            if (g->part2_3_length == 0 || p23_start >= m->res_len * 8U) continue;
            size_t clamp_end = (p23_end <= m->res_len * 8U) ? p23_end : (m->res_len * 8U);
            mp3_br_t br = { m->reservoir, p23_start, clamp_end };

            /* 1. Decode scalefactors */
            if (hdr.is_mpeg1) {
                int slen1 = mp3_slen1_tab[g->scalefac_compress & 15];
                int slen2 = mp3_slen2_tab[g->scalefac_compress & 15];
                if (g->window_switching && g->block_type == 2) {
                    if (g->mixed_block_flag) {
                        for (int sfb = 0; sfb < 8; sfb++) scalefac_l[ch][sfb] = (int)mp3_br_get(&br, slen1);
                        for (int sfb = 3; sfb < 6; sfb++)
                            for (int w = 0; w < 3; w++) scalefac_s[ch][sfb][w] = (int)mp3_br_get(&br, slen1);
                        for (int sfb = 6; sfb < 12; sfb++)
                            for (int w = 0; w < 3; w++) scalefac_s[ch][sfb][w] = (int)mp3_br_get(&br, slen2);
                    } else {
                        for (int sfb = 0; sfb < 6; sfb++)
                            for (int w = 0; w < 3; w++) scalefac_s[ch][sfb][w] = (int)mp3_br_get(&br, slen1);
                        for (int sfb = 6; sfb < 12; sfb++)
                            for (int w = 0; w < 3; w++) scalefac_s[ch][sfb][w] = (int)mp3_br_get(&br, slen2);
                    }
                } else {
                    static const int scfsi_bnd[5] = { 0, 6, 11, 16, 21 };
                    for (int grp = 0; grp < 4; grp++) {
                        int slen = (grp < 2) ? slen1 : slen2;
                        if (gr == 0 || scfsi[ch][grp] == 0) {
                            for (int sfb = scfsi_bnd[grp]; sfb < scfsi_bnd[grp + 1]; sfb++) {
                                scalefac_l[ch][sfb] = (int)mp3_br_get(&br, slen);
                            }
                        }
                    }
                }
            } else {
                /* MPEG-2 / MPEG-2.5 LSF scalefactors */
                uint32_t sfc = g->scalefac_compress;
                int slen[4] = {0};
                const int *nr = NULL;
                static const int nr_tab[6][4] = {
                    { 6, 5, 5, 5 }, { 6, 5, 7, 3 }, { 11, 10, 0, 0 },
                    { 7, 7, 7, 0 }, { 6, 6, 6, 3 }, { 8, 8, 5, 0 }
                };
                static const int nr_short[6][4] = {
                    { 9, 9, 9, 9 }, { 9, 9, 12, 6 }, { 18, 18, 0, 0 },
                    { 12, 12, 12, 0 }, { 12, 9, 9, 6 }, { 15, 12, 9, 0 }
                };
                bool is_ext = ((hdr.mode == 1) && (hdr.mode_ext & 1) && (ch == 1));
                int blk_sel = (g->window_switching && g->block_type == 2) ? (g->mixed_block_flag ? 2 : 1) : 0;
                if (!is_ext) {
                    if (sfc < 400) {
                        slen[0] = (int)((sfc >> 4) / 5);
                        slen[1] = (int)((sfc >> 4) % 5);
                        slen[2] = (int)((sfc & 15) >> 2);
                        slen[3] = (int)(sfc & 3);
                        g->preflag = 0;
                        nr = (blk_sel == 1) ? nr_short[0] : (blk_sel == 2 ? nr_short[1] : nr_tab[0]);
                    } else if (sfc < 500) {
                        uint32_t t = sfc - 400;
                        slen[0] = (int)((t >> 2) / 5);
                        slen[1] = (int)((t >> 2) % 5);
                        slen[2] = (int)(t & 3);
                        slen[3] = 0;
                        g->preflag = 0;
                        nr = (blk_sel == 1) ? nr_short[1] : nr_tab[1];
                    } else {
                        uint32_t t = sfc - 500;
                        slen[0] = (int)(t / 3);
                        slen[1] = (int)(t % 3);
                        slen[2] = 0; slen[3] = 0;
                        g->preflag = 1;
                        nr = (blk_sel == 1) ? nr_short[2] : nr_tab[2];
                    }
                } else {
                    uint32_t iv = sfc >> 1;
                    if (iv < 180) {
                        slen[0] = (int)(iv / 36); slen[1] = (int)((iv % 36) / 6); slen[2] = (int)(iv % 6);
                        nr = (blk_sel == 1) ? nr_short[3] : nr_tab[3];
                    } else if (iv < 244) {
                        uint32_t t = iv - 180;
                        slen[0] = (int)((t & 63) >> 4); slen[1] = (int)((t & 15) >> 2); slen[2] = (int)(t & 3);
                        nr = (blk_sel == 1) ? nr_short[4] : nr_tab[4];
                    } else {
                        uint32_t t = iv - 244;
                        slen[0] = (int)(t / 3); slen[1] = (int)(t % 3); slen[2] = 0;
                        nr = (blk_sel == 1) ? nr_short[5] : nr_tab[5];
                    }
                }
                if (blk_sel == 1) {
                    int idx = 0;
                    for (int p = 0; p < 4; p++) {
                        for (int k = 0; k < nr[p] && idx < 36; k++, idx++) {
                            scalefac_s[ch][idx / 3][idx % 3] = (int)mp3_br_get(&br, slen[p]);
                        }
                    }
                } else {
                    int sfb = 0;
                    for (int p = 0; p < 4; p++) {
                        for (int k = 0; k < nr[p] && sfb < 21; k++, sfb++) {
                            scalefac_l[ch][sfb] = (int)mp3_br_get(&br, slen[p]);
                        }
                    }
                }
            }

            /* 2. Decode Huffman spectral lines */
            int reg1_start = 576, reg2_start = 576;
            if (g->window_switching && g->block_type == 2) {
                reg1_start = 36;
                reg2_start = 576;
            } else {
                uint32_t r0 = g->region0_count + 1U;
                uint32_t r1 = r0 + g->region1_count + 1U;
                reg1_start = (r0 < 22U) ? sfb_l[r0] : 576;
                reg2_start = (r1 < 22U) ? sfb_l[r1] : 576;
            }

            int big_end = (int)(g->big_values * 2U);
            if (big_end > 576) big_end = 576;
            int idx = 0;

            while (idx < big_end && br.bit_pos < br.bit_end) {
                int reg = (idx < reg1_start) ? 0 : ((idx < reg2_start) ? 1 : 2);
                uint32_t tbl = g->table_select[reg] & 31U;
                if (tbl == 0) {
                    is_val[ch][idx++] = 0;
                    is_val[ch][idx++] = 0;
                    continue;
                }
                int sym = mp3_huff_decode_sym(&br, g_huff_roots[tbl]);
                int x = (sym >> 4) & 15;
                int y = sym & 15;
                uint8_t lb = mp3_huff_books[tbl].linbits;

                if (x == 15 && lb > 0) x += (int)mp3_br_get(&br, lb);
                if (x != 0 && mp3_br_get1(&br)) x = -x;
                if (y == 15 && lb > 0) y += (int)mp3_br_get(&br, lb);
                if (y != 0 && mp3_br_get1(&br)) y = -y;

                is_val[ch][idx++] = x;
                is_val[ch][idx++] = y;
            }

            while (idx <= 572 && br.bit_pos < br.bit_end) {
                int quad = (g->count1table_select == 0)
                    ? mp3_huff_decode_sym(&br, g_count1a_root)
                    : (int)(mp3_br_get(&br, 4) ^ 0x0FU);
                for (int q = 3; q >= 0; q--) {
                    int v = (quad >> q) & 1;
                    if (v != 0 && mp3_br_get1(&br)) v = -v;
                    is_val[ch][idx++] = v;
                }
            }
            rzero_idx[ch] = idx;

            /* 3. Requantization (+ short-block reordering) */
            double sf_mult = g->scalefac_scale ? 1.0 : 0.5;
            if (g->window_switching && g->block_type == 2) {
                double tmp[576];
                memset(tmp, 0, sizeof(tmp));
                int start_sfb = 0;
                int out_i = 0;
                if (g->mixed_block_flag) {
                    for (int sfb = 0; sfb < 8; sfb++) {
                        int pt = g->preflag ? mp3_pretab[sfb] : 0;
                        double gain = pow(2.0, 0.25 * ((double)g->global_gain - 210.0) - sf_mult * (double)(scalefac_l[ch][sfb] + pt));
                        for (int i = sfb_l[sfb]; i < sfb_l[sfb + 1] && i < 36; i++) {
                            int v = is_val[ch][i];
                            int av = v < 0 ? -v : v;
                            if (av > 8207) av = 8207;
                            tmp[i] = (v < 0 ? -g_pow43[av] : g_pow43[av]) * gain;
                        }
                    }
                    start_sfb = 3;
                    out_i = 36;
                }
                int src_i = out_i;
                for (int sfb = start_sfb; sfb < 13; sfb++) {
                    int width = sfb_s[sfb + 1] - sfb_s[sfb];
                    double wgain[3];
                    for (int w = 0; w < 3; w++) {
                        int scf = (sfb < 12) ? scalefac_s[ch][sfb][w] : 0;
                        wgain[w] = pow(2.0, 0.25 * ((double)g->global_gain - 210.0 - 8.0 * (double)g->subblock_gain[w]) - sf_mult * (double)scf);
                    }
                    double sub_win[3][64];
                    for (int w = 0; w < 3; w++) {
                        for (int k = 0; k < width && src_i < 576; k++, src_i++) {
                            int v = is_val[ch][src_i];
                            int av = v < 0 ? -v : v;
                            if (av > 8207) av = 8207;
                            sub_win[w][k] = (v < 0 ? -g_pow43[av] : g_pow43[av]) * wgain[w];
                        }
                    }
                    for (int k = 0; k < width && out_i + 2 < 576; k++) {
                        tmp[out_i++] = sub_win[0][k];
                        tmp[out_i++] = sub_win[1][k];
                        tmp[out_i++] = sub_win[2][k];
                    }
                }
                memcpy(xr[ch], tmp, sizeof(tmp));
            } else {
                for (int sfb = 0; sfb < 22; sfb++) {
                    int scf = (sfb < 21) ? scalefac_l[ch][sfb] : 0;
                    int pt  = (g->preflag && sfb < 21) ? mp3_pretab[sfb] : 0;
                    double gain = pow(2.0, 0.25 * ((double)g->global_gain - 210.0) - sf_mult * (double)(scf + pt));
                    for (int i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
                        int v = is_val[ch][i];
                        if (v == 0) {
                            xr[ch][i] = 0.0;
                        } else {
                            int av = v < 0 ? -v : v;
                            if (av > 8207) av = 8207;
                            xr[ch][i] = (v < 0 ? -g_pow43[av] : g_pow43[av]) * gain;
                        }
                    }
                }
            }
        }

        /* 4. Stereo MS / Intensity processing */
        if (hdr.channels == 2 && hdr.mode == 1) {
            bool ms_stereo  = (hdr.mode_ext & 2U) != 0;
            bool int_stereo = (hdr.mode_ext & 1U) != 0;
            int is_bound = 576;

            if (int_stereo) {
                is_bound = rzero_idx[1];
                if (hdr.is_mpeg1 && !(gi[gr][1].window_switching && gi[gr][1].block_type == 2)) {
                    for (int sfb = 0; sfb < 21; sfb++) {
                        if (sfb_l[sfb + 1] <= is_bound) continue;
                        int is_pos = scalefac_l[1][sfb];
                        if (is_pos == 7) {
                            if (ms_stereo) {
                                const double inv_sqrt2 = 0.7071067811865475244;
                                for (int i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
                                    double l = (xr[0][i] + xr[1][i]) * inv_sqrt2;
                                    double r = (xr[0][i] - xr[1][i]) * inv_sqrt2;
                                    xr[0][i] = l;
                                    xr[1][i] = r;
                                }
                            }
                        } else {
                            double ratio = tan((double)is_pos * (M_PI / 12.0));
                            double kl = ratio / (1.0 + ratio);
                            double kr = 1.0 / (1.0 + ratio);
                            for (int i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
                                double mval = xr[0][i];
                                xr[0][i] = mval * kl;
                                xr[1][i] = mval * kr;
                            }
                        }
                    }
                }
            }
            if (ms_stereo) {
                const double inv_sqrt2 = 0.7071067811865475244;
                for (int i = 0; i < is_bound; i++) {
                    double l = (xr[0][i] + xr[1][i]) * inv_sqrt2;
                    double r = (xr[0][i] - xr[1][i]) * inv_sqrt2;
                    xr[0][i] = l;
                    xr[1][i] = r;
                }
            }
        }

        /* 5. Alias reduction, IMDCT + overlap-add, frequency inversion, 32-subband synthesis */
        double sub_samples[2][18][32];
        for (uint16_t ch = 0; ch < hdr.channels; ch++) {
            mp3_gran_ch_t *g = &gi[gr][ch];
            int alias_sbs = 31;
            if (g->window_switching && g->block_type == 2) {
                alias_sbs = g->mixed_block_flag ? 1 : 0;
            }
            for (int sb = 0; sb < alias_sbs; sb++) {
                int base = sb * 18;
                for (int k = 0; k < 8; k++) {
                    double bu = xr[ch][base + 17 - k];
                    double bd = xr[ch][base + 18 + k];
                    xr[ch][base + 17 - k] = bu * g_alias_cs[k] - bd * g_alias_ca[k];
                    xr[ch][base + 18 + k] = bd * g_alias_cs[k] + bu * g_alias_ca[k];
                }
            }

            for (int sb = 0; sb < 32; sb++) {
                const double *in18 = &xr[ch][sb * 18];
                double raw36[36];
                bool use_short = (g->window_switching && g->block_type == 2 && (!g->mixed_block_flag || sb >= 2));

                if (use_short) {
                    memset(raw36, 0, sizeof(raw36));
                    for (int w = 0; w < 3; w++) {
                        double x6[6];
                        for (int k = 0; k < 6; k++) x6[k] = in18[3 * k + w];
                        for (int i = 0; i < 12; i++) {
                            double sum = 0.0;
                            for (int k = 0; k < 6; k++) sum += x6[k] * g_cos_imdct12[k][i];
                            raw36[6 * w + 6 + i] += sum * g_imdct_win[2][i];
                        }
                    }
                } else {
                    uint32_t bt = g->window_switching ? g->block_type : 0U;
                    if (bt == 2U) bt = 0U;
                    for (int i = 0; i < 36; i++) {
                        double sum = 0.0;
                        for (int k = 0; k < 18; k++) sum += in18[k] * g_cos_imdct36[k][i];
                        raw36[i] = sum * g_imdct_win[bt][i];
                    }
                }

                for (int ss = 0; ss < 18; ss++) {
                    double v = raw36[ss] + m->prev_blck[ch][sb][ss];
                    m->prev_blck[ch][sb][ss] = raw36[ss + 18];
                    if ((sb & 1) && (ss & 1)) v = -v;
                    sub_samples[ch][ss][sb] = v;
                }
            }
        }

        double *gr_dst = m->out_pcm + (size_t)gr * 576U * hdr.channels;
        for (int ss = 0; ss < 18; ss++) {
            double *ss_dst = gr_dst + (size_t)ss * 32U * hdr.channels;
            for (uint16_t ch = 0; ch < hdr.channels; ch++) {
                mp3_synth_32(m, ch, sub_samples[ch][ss], ss_dst, hdr.channels);
            }
        }
    }

    m->pcm_avail = (uint32_t)granules * 576U;
    m->pcm_pos = 0;

    if (m->skip_remaining > 0) {
        uint32_t drop = (m->skip_remaining < m->pcm_avail) ? m->skip_remaining : m->pcm_avail;
        m->pcm_pos += drop;
        m->skip_remaining -= drop;
    }
    return true;
}

static int mp3_read_frames(om_decoder_t *dec, int32_t *out_i32, double *out_f64, size_t max_frames) {
    mp3_priv_t *m = (mp3_priv_t *)dec->priv;
    if (!m || !m->fp || max_frames == 0) return 0;

    uint16_t channels = dec->info.channels;
    size_t produced = 0;

    while (produced < max_frames) {
        if (dec->info.total_frames > 0 && m->frames_emitted >= dec->info.total_frames) break;
        if (m->pcm_pos >= m->pcm_avail) {
            if (!mp3_decode_mpeg_frame(dec)) break;
            if (m->pcm_pos >= m->pcm_avail) continue;
        }

        uint32_t avail = m->pcm_avail - m->pcm_pos;
        size_t want = max_frames - produced;
        if (avail < want) want = avail;
        if (dec->info.total_frames > 0 && m->frames_emitted + want > dec->info.total_frames) {
            want = (size_t)(dec->info.total_frames - m->frames_emitted);
        }

        for (size_t i = 0; i < want; i++) {
            size_t sbase = (size_t)(m->pcm_pos + (uint32_t)i) * channels;
            size_t dbase = (produced + i) * channels;
            for (uint16_t ch = 0; ch < channels; ch++) {
                double dv = m->out_pcm[sbase + ch];
                if (out_f64) out_f64[dbase + ch] = dv;
                if (out_i32) out_i32[dbase + ch] = om_f64_to_i32(dv, 24);
            }
        }
        m->pcm_pos += (uint32_t)want;
        m->frames_emitted += want;
        produced += want;
    }
    return (int)produced;
}

static int mp3_seek_frame(om_decoder_t *dec, uint64_t target_frame) {
    mp3_priv_t *m = (mp3_priv_t *)dec->priv;
    if (!m || !m->fp) return -1;
    if (dec->info.total_frames > 0 && target_frame > dec->info.total_frames) {
        target_frame = dec->info.total_frames;
    }

    double ratio = (dec->info.total_frames > 0)
        ? ((double)target_frame / (double)dec->info.total_frames)
        : 0.0;
    if (ratio < 0.0) ratio = 0.0;
    if (ratio > 1.0) ratio = 1.0;

    uint64_t span = (m->audio_end_off > m->audio_start_off) ? (m->audio_end_off - m->audio_start_off) : 0;
    uint64_t byte_off = m->audio_start_off;
    if (target_frame == 0) {
        byte_off = m->audio_start_off;
        m->skip_remaining = m->skip_lead_frames;
    } else if (m->has_toc) {
        double pct = ratio * 100.0;
        int idx = (int)pct;
        if (idx > 99) idx = 99;
        double fa = (double)m->xing_toc[idx];
        double fb = (idx < 99) ? (double)m->xing_toc[idx + 1] : 256.0;
        double interp = fa + (fb - fa) * (pct - (double)idx);
        byte_off = m->audio_start_off + (uint64_t)((interp / 256.0) * (double)span);
        m->skip_remaining = 0;
    } else {
        byte_off = m->audio_start_off + (uint64_t)(ratio * (double)span);
        m->skip_remaining = 0;
    }

#ifdef _WIN32
    _fseeki64(m->fp, (int64_t)byte_off, SEEK_SET);
#else
    fseeko(m->fp, (off_t)byte_off, SEEK_SET);
#endif
    m->res_len = 0;
    m->pcm_avail = 0;
    m->pcm_pos = 0;
    memset(m->prev_blck, 0, sizeof(m->prev_blck));
    memset(m->synth_v, 0, sizeof(m->synth_v));
    m->synth_off[0] = m->synth_off[1] = 0;
    m->frames_emitted = target_frame;
    return 0;
}

static void mp3_close(om_decoder_t *dec) {
    if (!dec || !dec->priv) return;
    mp3_priv_t *m = (mp3_priv_t *)dec->priv;
    if (m->fp) fclose(m->fp);
    free(m);
    dec->priv = NULL;
}

static uint32_t mp3_be32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8)  | (uint32_t)p[3];
}

int om_decoder_open_mp3(const char *path, om_decoder_t *out_dec, char *err, size_t err_cap) {
    mp3_init_global_tables();
    memset(out_dec, 0, sizeof(*out_dec));

    FILE *fp = fopen(path, "rb");
    if (!fp) {
        snprintf(err, err_cap, "Cannot open MP3 file: %s", path);
        return -1;
    }

#ifdef _WIN32
    _fseeki64(fp, 0, SEEK_END);
    uint64_t file_size = (uint64_t)_ftelli64(fp);
    _fseeki64(fp, 0, SEEK_SET);
#else
    fseeko(fp, 0, SEEK_END);
    uint64_t file_size = (uint64_t)ftello(fp);
    fseeko(fp, 0, SEEK_SET);
#endif

    uint64_t audio_end = file_size;
    if (file_size >= 128) {
        uint8_t tail[3];
#ifdef _WIN32
        _fseeki64(fp, (int64_t)(file_size - 128), SEEK_SET);
#else
        fseeko(fp, (off_t)(file_size - 128), SEEK_SET);
#endif
        if (fread(tail, 1, 3, fp) == 3 && memcmp(tail, "TAG", 3) == 0) {
            audio_end -= 128;
        }
#ifdef _WIN32
        _fseeki64(fp, 0, SEEK_SET);
#else
        fseeko(fp, 0, SEEK_SET);
#endif
    }

    /* Skip leading ID3v2 tag(s) */
    uint64_t start_off = 0;
    while (start_off + 10 <= audio_end) {
        uint8_t id3[10];
#ifdef _WIN32
        _fseeki64(fp, (int64_t)start_off, SEEK_SET);
#else
        fseeko(fp, (off_t)start_off, SEEK_SET);
#endif
        if (fread(id3, 1, 10, fp) != 10 || memcmp(id3, "ID3", 3) != 0) break;
        uint32_t sz = ((uint32_t)(id3[6] & 0x7F) << 21) |
                      ((uint32_t)(id3[7] & 0x7F) << 14) |
                      ((uint32_t)(id3[8] & 0x7F) << 7)  |
                      (uint32_t)(id3[9] & 0x7F);
        start_off += 10ULL + sz + ((id3[5] & 0x10U) ? 10ULL : 0ULL);
    }

    /* Probe two consecutive valid Layer III frames to confirm stream format */
    mp3_hdr_t first_hdr;
    memset(&first_hdr, 0, sizeof(first_hdr));
    bool synced = false;
    uint8_t fbuf[2880];

    for (uint64_t probe = start_off; probe + 8 <= audio_end && probe < start_off + 131072ULL; probe++) {
#ifdef _WIN32
        _fseeki64(fp, (int64_t)probe, SEEK_SET);
#else
        fseeko(fp, (off_t)probe, SEEK_SET);
#endif
        uint8_t h1[4], h2[4];
        if (fread(h1, 1, 4, fp) != 4) break;
        if (!mp3_parse_header(h1, &first_hdr)) continue;

        if (probe + first_hdr.frame_bytes + 4 <= audio_end) {
#ifdef _WIN32
            _fseeki64(fp, (int64_t)(probe + first_hdr.frame_bytes), SEEK_SET);
#else
            fseeko(fp, (off_t)(probe + first_hdr.frame_bytes), SEEK_SET);
#endif
            mp3_hdr_t second_hdr;
            if (fread(h2, 1, 4, fp) == 4 && mp3_parse_header(h2, &second_hdr) &&
                second_hdr.sample_rate == first_hdr.sample_rate &&
                second_hdr.channels == first_hdr.channels) {
                start_off = probe;
                synced = true;
                break;
            }
        } else {
            start_off = probe;
            synced = true;
            break;
        }
    }

    if (!synced) {
        fclose(fp);
        snprintf(err, err_cap, "No valid MPEG Layer III frame sync found");
        return -1;
    }

    mp3_priv_t *m = (mp3_priv_t *)calloc(1, sizeof(*m));
    m->fp = fp;
    m->audio_start_off = start_off;
    m->audio_end_off = audio_end;
    m->skip_lead_frames = 528; /* Standard synthesis filterbank + hybrid IMDCT delay */

    /* Inspect first frame for Xing/Info VBR + LAME gapless header */
#ifdef _WIN32
    _fseeki64(fp, (int64_t)start_off, SEEK_SET);
#else
    fseeko(fp, (off_t)start_off, SEEK_SET);
#endif
    uint64_t total_pcm_frames = 0;
    uint32_t spf = first_hdr.is_mpeg1 ? 1152U : 576U;

    if (first_hdr.frame_bytes <= sizeof(fbuf) && fread(fbuf, 1, first_hdr.frame_bytes, fp) == first_hdr.frame_bytes) {
        size_t xoff = 4U + first_hdr.sideinfo_bytes;
        if (xoff + 8 <= first_hdr.frame_bytes &&
            (memcmp(fbuf + xoff, "Xing", 4) == 0 || memcmp(fbuf + xoff, "Info", 4) == 0)) {
            uint32_t flags = mp3_be32(fbuf + xoff + 4);
            size_t cur = xoff + 8;
            uint32_t xing_frames = 0;
            if ((flags & 1U) && cur + 4 <= first_hdr.frame_bytes) {
                xing_frames = mp3_be32(fbuf + cur);
                cur += 4;
            }
            if ((flags & 2U) && cur + 4 <= first_hdr.frame_bytes) cur += 4;
            if ((flags & 4U) && cur + 100 <= first_hdr.frame_bytes) {
                memcpy(m->xing_toc, fbuf + cur, 100);
                m->has_toc = true;
                cur += 100;
            }
            if ((flags & 8U) && cur + 4 <= first_hdr.frame_bytes) cur += 4;

            /* LAME / Lavc / Lavf gapless delay & padding */
            uint32_t enc_delay = 576, enc_pad = 0;
            if (cur + 24 <= first_hdr.frame_bytes &&
                (memcmp(fbuf + cur, "LAME", 4) == 0 ||
                 memcmp(fbuf + cur, "Lavc", 4) == 0 ||
                 memcmp(fbuf + cur, "Lavf", 4) == 0)) {
                const uint8_t *gp = fbuf + cur + 21;
                uint32_t d = ((uint32_t)gp[0] << 4) | ((uint32_t)gp[1] >> 4);
                uint32_t p = ((uint32_t)(gp[1] & 0x0FU) << 8) | (uint32_t)gp[2];
                if (d < 2880 && p < 5760) {
                    enc_delay = d;
                    enc_pad = p;
                }
            }
            m->skip_lead_frames = enc_delay + 528U;
            m->audio_start_off = start_off + first_hdr.frame_bytes; /* Skip silent Xing frame */
            if (xing_frames > 0) {
                uint64_t raw_total = (uint64_t)xing_frames * spf;
                uint64_t trim = (uint64_t)enc_delay + (uint64_t)enc_pad;
                total_pcm_frames = (raw_total > trim) ? (raw_total - trim) : raw_total;
            }
        }
    }

    if (total_pcm_frames == 0) {
        double bytes = (double)(m->audio_end_off - m->audio_start_off);
        double sec = (bytes * 8.0) / ((double)first_hdr.bitrate_kbps * 1000.0);
        total_pcm_frames = (uint64_t)(sec * (double)first_hdr.sample_rate);
    }

    m->skip_remaining = m->skip_lead_frames;
#ifdef _WIN32
    _fseeki64(fp, (int64_t)m->audio_start_off, SEEK_SET);
#else
    fseeko(fp, (off_t)m->audio_start_off, SEEK_SET);
#endif

    out_dec->name = "MP3";
    out_dec->priv = m;
    out_dec->info.codec = OM_CODEC_MP3;
    out_dec->info.sample_rate = first_hdr.sample_rate;
    out_dec->info.channels = first_hdr.channels;
    out_dec->info.bit_depth = 24;
    out_dec->info.is_float = true;
    out_dec->info.is_dop = false;
    out_dec->info.total_frames = total_pcm_frames;
    out_dec->info.duration_sec = (double)total_pcm_frames / (double)first_hdr.sample_rate;
    out_dec->read_frames = mp3_read_frames;
    out_dec->seek_frame = mp3_seek_frame;
    out_dec->close = mp3_close;
    return 0;
}
