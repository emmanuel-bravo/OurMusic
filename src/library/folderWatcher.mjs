import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

function isHiddenOrTempRelative(absRoot, targetPath) {
  const rel = path.relative(absRoot, targetPath);
  if (!rel || rel.startsWith('..')) return true;
  const parts = rel.split(path.sep);
  for (const p of parts) {
    if (p.startsWith('.') && p.length > 1) return true;
  }
  const lower = rel.toLowerCase();
  return lower.endsWith('.tmp') || lower.endsWith('.part') || lower.endsWith('.crdownload');
}

/**
 * Cross-platform Incremental OS File Watcher (Linux inotify / Windows ReadDirectoryChangesW).
 * Detects newly added, modified, renamed, or deleted audio files and album folders in real time
 * with per-path write-coalescing debounce.
 */
export class FolderWatcher {
  constructor({
    supportedExtensions,
    debounceMs = 200,
    onFileChanged,
    onFileRemoved,
    onDirectoryAdded,
    onDirectoryRemoved,
  }) {
    this.supportedExtensions = supportedExtensions;
    this.debounceMs = debounceMs;
    this.onFileChanged = onFileChanged;
    this.onFileRemoved = onFileRemoved;
    this.onDirectoryAdded = onDirectoryAdded;
    this.onDirectoryRemoved = onDirectoryRemoved;

    this.rootWatchers = new Map(); // rootDir -> Set<FSWatcher>
    this.pendingTimers = new Map(); // targetPath -> Timeout
    this.processing = new Set();
    this.closed = false;
  }

  async watchRoot(dirPath) {
    if (this.closed) return;
    const absRoot = path.resolve(dirPath);
    if (this.rootWatchers.has(absRoot)) return;
    if (!fs.existsSync(absRoot)) return;

    const handles = new Set();
    this.rootWatchers.set(absRoot, handles);

    try {
      const watcher = fs.watch(
        absRoot,
        { recursive: true },
        (_eventType, filename) => {
          if (this.closed || !filename) return;
          const target = path.resolve(absRoot, String(filename));
          this._schedulePath(absRoot, target);
        },
      );
      watcher.on('error', () => {});
      watcher.unref?.();
      handles.add(watcher);
    } catch (err) {
      if (err?.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
        await this._watchTreeFallback(absRoot, absRoot, handles);
      }
    }
  }

  async _watchTreeFallback(absRoot, dirPath, handles) {
    if (this.closed) return;
    const stack = [dirPath];
    while (stack.length > 0 && !this.closed) {
      const cur = stack.pop();
      try {
        const w = fs.watch(cur, (_eventType, filename) => {
          if (this.closed || !filename) return;
          const target = path.resolve(cur, String(filename));
          this._schedulePath(absRoot, target, handles);
        });
        w.on('error', () => {});
        w.unref?.();
        handles.add(w);
      } catch {
        continue;
      }

      let entries;
      try {
        entries = await fsp.readdir(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) {
          stack.push(path.join(cur, ent.name));
        }
      }
    }
  }

  _schedulePath(absRoot, targetPath, fallbackHandles = null) {
    if (this.closed || isHiddenOrTempRelative(absRoot, targetPath)) return;
    const prev = this.pendingTimers.get(targetPath);
    if (prev) clearTimeout(prev);

    const timer = setTimeout(async () => {
      this.pendingTimers.delete(targetPath);
      if (this.closed || this.processing.has(targetPath)) return;
      this.processing.add(targetPath);
      try {
        await this._handleSettledPath(absRoot, targetPath, fallbackHandles);
      } catch {
        // Ignore transient race conditions during external file moves
      } finally {
        this.processing.delete(targetPath);
      }
    }, this.debounceMs);
    timer.unref?.();
    this.pendingTimers.set(targetPath, timer);
  }

  async _handleSettledPath(absRoot, targetPath, fallbackHandles) {
    let st = null;
    try {
      st = await fsp.stat(targetPath);
    } catch {
      st = null;
    }

    const ext = path.extname(targetPath).toLowerCase();
    const isAudioExt = this.supportedExtensions.has(ext);

    if (!st) {
      if (isAudioExt) {
        await this.onFileRemoved?.(targetPath);
      } else {
        await this.onDirectoryRemoved?.(targetPath);
      }
      return;
    }

    if (st.isDirectory()) {
      if (fallbackHandles) {
        await this._watchTreeFallback(absRoot, targetPath, fallbackHandles);
      }
      await this.onDirectoryAdded?.(targetPath);
      return;
    }

    if (st.isFile() && isAudioExt && st.size > 0) {
      await this.onFileChanged?.(targetPath);
    }
  }

  unwatchRoot(dirPath) {
    const absRoot = path.resolve(dirPath);
    const handles = this.rootWatchers.get(absRoot);
    if (!handles) return;
    for (const h of handles) {
      try {
        h.close();
      } catch {
        // ignore
      }
    }
    this.rootWatchers.delete(absRoot);
  }

  watchedRootCount() {
    return this.rootWatchers.size;
  }

  close() {
    this.closed = true;
    for (const [, timer] of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    for (const [, handles] of this.rootWatchers) {
      for (const h of handles) {
        try {
          h.close();
        } catch {
          // ignore
        }
      }
    }
    this.rootWatchers.clear();
  }
}
