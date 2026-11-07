#ifndef OURMUSIC_OS_COMPAT_H
#define OURMUSIC_OS_COMPAT_H

#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <process.h>
#include <io.h>
#include <fcntl.h>

typedef CRITICAL_SECTION om_mutex_t;
typedef CONDITION_VARIABLE om_cond_t;
typedef HANDLE om_thread_t;
typedef void *(*om_thread_fn)(void *);

typedef struct {
    om_thread_fn fn;
    void *arg;
} om_win_thread_wrap_t;

static inline unsigned __stdcall om_win_thread_entry(void *raw) {
    om_win_thread_wrap_t *w = (om_win_thread_wrap_t *)raw;
    om_thread_fn fn = w->fn;
    void *arg = w->arg;
    free(w);
    fn(arg);
    return 0;
}

static inline void om_mutex_init(om_mutex_t *m) { InitializeCriticalSection(m); }
static inline void om_mutex_destroy(om_mutex_t *m) { DeleteCriticalSection(m); }
static inline void om_mutex_lock(om_mutex_t *m) { EnterCriticalSection(m); }
static inline void om_mutex_unlock(om_mutex_t *m) { LeaveCriticalSection(m); }

static inline void om_cond_init(om_cond_t *c) { InitializeConditionVariable(c); }
static inline void om_cond_destroy(om_cond_t *c) { (void)c; }
static inline void om_cond_signal(om_cond_t *c) { WakeConditionVariable(c); }
static inline void om_cond_broadcast(om_cond_t *c) { WakeAllConditionVariable(c); }
static inline void om_cond_wait(om_cond_t *c, om_mutex_t *m) {
    SleepConditionVariableCS(c, m, INFINITE);
}
static inline void om_cond_timedwait_ms(om_cond_t *c, om_mutex_t *m, uint32_t ms) {
    SleepConditionVariableCS(c, m, (DWORD)ms);
}

static inline int om_thread_create(om_thread_t *t, om_thread_fn fn, void *arg) {
    om_win_thread_wrap_t *w = (om_win_thread_wrap_t *)malloc(sizeof(*w));
    if (!w) return -1;
    w->fn = fn;
    w->arg = arg;
    uintptr_t h = _beginthreadex(NULL, 0, om_win_thread_entry, w, 0, NULL);
    if (h == 0) {
        free(w);
        return -1;
    }
    *t = (HANDLE)h;
    return 0;
}

static inline void om_thread_join(om_thread_t t) {
    if (t) {
        WaitForSingleObject(t, INFINITE);
        CloseHandle(t);
    }
}

static inline void om_sleep_ms(uint32_t ms) { Sleep((DWORD)ms); }

static inline uint64_t om_monotonic_ns(void) {
    LARGE_INTEGER freq, cnt;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&cnt);
    return (uint64_t)((double)cnt.QuadPart * 1e9 / (double)freq.QuadPart);
}

#else /* POSIX / Linux */

#include <pthread.h>
#include <time.h>
#include <unistd.h>
#include <strings.h>

typedef pthread_mutex_t om_mutex_t;
typedef pthread_cond_t om_cond_t;
typedef pthread_t om_thread_t;
typedef void *(*om_thread_fn)(void *);

static inline void om_mutex_init(om_mutex_t *m) { pthread_mutex_init(m, NULL); }
static inline void om_mutex_destroy(om_mutex_t *m) { pthread_mutex_destroy(m); }
static inline void om_mutex_lock(om_mutex_t *m) { pthread_mutex_lock(m); }
static inline void om_mutex_unlock(om_mutex_t *m) { pthread_mutex_unlock(m); }

static inline void om_cond_init(om_cond_t *c) { pthread_cond_init(c, NULL); }
static inline void om_cond_destroy(om_cond_t *c) { pthread_cond_destroy(c); }
static inline void om_cond_signal(om_cond_t *c) { pthread_cond_signal(c); }
static inline void om_cond_broadcast(om_cond_t *c) { pthread_cond_broadcast(c); }
static inline void om_cond_wait(om_cond_t *c, om_mutex_t *m) {
    pthread_cond_wait(c, m);
}
static inline void om_cond_timedwait_ms(om_cond_t *c, om_mutex_t *m, uint32_t ms) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += ms / 1000;
    ts.tv_nsec += (long)(ms % 1000) * 1000000L;
    if (ts.tv_nsec >= 1000000000L) {
        ts.tv_sec += 1;
        ts.tv_nsec -= 1000000000L;
    }
    pthread_cond_timedwait(c, m, &ts);
}

static inline int om_thread_create(om_thread_t *t, om_thread_fn fn, void *arg) {
    return pthread_create(t, NULL, fn, arg);
}

static inline void om_thread_join(om_thread_t t) {
    pthread_join(t, NULL);
}

static inline void om_sleep_ms(uint32_t ms) {
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (long)(ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
}

static inline uint64_t om_monotonic_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

#endif

#ifdef _WIN32
#define om_strcasecmp _stricmp
#else
#define om_strcasecmp strcasecmp
#endif

#endif /* OURMUSIC_OS_COMPAT_H */
