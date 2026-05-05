/**
 * ChatPage — embeds `hermes --tui` inside the dashboard.
 *
 *   <div host> (dashboard chrome)                                         .
 *     └─ <div wrapper> (rounded, dark bg, padded — the "terminal window"  .
 *         look that gives the page a distinct visual identity)            .
 *         └─ @xterm/xterm Terminal (WebGL renderer, Unicode 11 widths)    .
 *              │ onData      keystrokes → WebSocket → PTY master          .
 *              │ onResize    terminal resize → `\x1b[RESIZE:cols;rows]`   .
 *              │ write(data) PTY output bytes → VT100 parser              .
 *              ▼                                                          .
 *     WebSocket /api/pty?token=<session>                                  .
 *          ▼                                                              .
 *     FastAPI pty_ws  (hermes_cli/web_server.py)                          .
 *          ▼                                                              .
 *     POSIX PTY → `node ui-tui/dist/entry.js` → tui_gateway + AIAgent     .
 */

import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@nous-research/ui/ui/components/button";
import { Typography } from "@/components/NouiTypography";
import { cn } from "@/lib/utils";
import { Copy, ListOrdered, PanelRight, SquareTerminal, StopCircle, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";

import { ChatSidebar } from "@/components/ChatSidebar";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useI18n } from "@/i18n";
import { PluginSlot } from "@/plugins";

function buildWsUrl(
  token: string,
  resume: string | null,
  channel: string,
): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const qs = new URLSearchParams({ token, channel });
  if (resume) qs.set("resume", resume);
  return `${proto}//${window.location.host}/api/pty?${qs.toString()}`;
}

// Channel id ties this chat tab's PTY child (publisher) to its sidebar
// (subscriber).  Generated once per mount so a tab refresh starts a fresh
// channel — the previous PTY child terminates with the old WS, and its
// channel auto-evicts when no subscribers remain.
function generateChannelId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `chat-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

// Colors for the terminal body.  Matches the dashboard's dark teal canvas
// with cream foreground — we intentionally don't pick monokai or a loud
// theme, because the TUI's skin engine already paints the content; the
// terminal chrome just needs to sit quietly inside the dashboard.
const TERMINAL_THEME = {
  background: "#0d2626",
  foreground: "#f0e6d2",
  cursor: "#f0e6d2",
  cursorAccent: "#0d2626",
  selectionBackground: "#f0e6d244",
};

/**
 * CSS width for xterm font tiers.
 *
 * Prefer the terminal host's `clientWidth` — Chrome DevTools device mode often
 * keeps `window.innerWidth` at the full desktop value while the *drawn* layout
 * is phone-sized, which made us pick desktop font sizes (~14px) and look huge.
 */
function terminalTierWidthPx(host: HTMLElement | null): number {
  if (typeof window === "undefined") return 1280;
  const fromHost = host?.clientWidth ?? 0;
  if (fromHost > 2) return Math.round(fromHost);
  const doc = document.documentElement?.clientWidth ?? 0;
  const vv = window.visualViewport;
  const inner = window.innerWidth;
  const vvw = vv?.width ?? inner;
  const layout = Math.min(inner, vvw, doc > 0 ? doc : inner);
  return Math.max(1, Math.round(layout));
}

function terminalFontSizeForWidth(layoutWidthPx: number): number {
  if (layoutWidthPx < 300) return 7;
  if (layoutWidthPx < 360) return 8;
  if (layoutWidthPx < 420) return 9;
  if (layoutWidthPx < 520) return 10;
  if (layoutWidthPx < 720) return 11;
  if (layoutWidthPx < 1024) return 12;
  return 14;
}

function terminalLineHeightForWidth(layoutWidthPx: number): number {
  return layoutWidthPx < 1024 ? 1.02 : 1.15;
}

export default function ChatPage({ isActive = true }: { isActive?: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [inputValue, setInputValue] = useState("");
  // Exposed to the main metrics-sync effect so it can refit the terminal
  // the moment `isActive` flips back to true (display:none → display:flex
  // collapses the host's box, so ResizeObserver never fires on return).
  const syncMetricsRef = useRef<(() => void) | null>(null);
  const [searchParams] = useSearchParams();
  // Lazy-init: the missing-token check happens at construction so the effect
  // body doesn't have to setState (React 19's set-state-in-effect rule).
  const [banner, setBanner] = useState<string | null>(() =>
    typeof window !== "undefined" && !window.__HERMES_SESSION_TOKEN__
      ? "Session token unavailable. Open this page through `hermes dashboard`, not directly."
      : null,
  );
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Raw state for the mobile side-sheet + a derived value that force-
  // closes whenever the chat tab isn't active.  The *derived* value is
  // what side-effects (body-scroll lock, keydown listener, portal render)
  // key on — that way switching to another tab triggers the effect's
  // cleanup, releasing the scroll-lock on /sessions etc.  Returning to
  // /chat re-runs the effect (derived flips back to true) and re-locks.
  // Keying on the raw state would leak the body.overflow="hidden" across
  // tabs because the dep wouldn't change on tab switch.
  const [mobilePanelOpenRaw, setMobilePanelOpenRaw] = useState(false);
  const mobilePanelOpen = isActive && mobilePanelOpenRaw;
  const { setEnd } = usePageHeader();
  const { t } = useI18n();
  const closeMobilePanel = useCallback(() => setMobilePanelOpenRaw(false), []);
  const modelToolsLabel = useMemo(
    () => `${t.app.modelToolsSheetTitle} ${t.app.modelToolsSheetSubtitle}`,
    [t.app.modelToolsSheetSubtitle, t.app.modelToolsSheetTitle],
  );
  const [portalRoot] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? document.body : null,
  );
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 1023px)").matches
      : false,
  );

  const resumeRef = useRef<string | null>(searchParams.get("resume"));
  const channel = useMemo(() => generateChannelId(), []);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1023px)");
    const sync = () => setNarrow(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!mobilePanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMobilePanel();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobilePanelOpen, closeMobilePanel]);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMobilePanelOpenRaw(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    // When hidden (non-chat tab) we must not register the header button —
    // another page owns the header's end slot at that point.
    if (!isActive) {
      setEnd(null);
      return;
    }
    if (!narrow) {
      setEnd(null);
      return;
    }
    setEnd(
      <Button
        ghost
        onClick={() => setMobilePanelOpenRaw(true)}
        aria-expanded={mobilePanelOpen}
        aria-controls="chat-side-panel"
        className={cn(
          "shrink-0 rounded border border-current/20",
          "px-2 py-1 text-[0.65rem] font-medium tracking-wide normal-case",
          "text-midground/80 hover:text-midground hover:bg-midground/5",
        )}
      >
        <span className="inline-flex items-center gap-1.5">
          <PanelRight className="h-3 w-3 shrink-0" />
          {modelToolsLabel}
        </span>
      </Button>,
    );
    return () => setEnd(null);
  }, [isActive, narrow, mobilePanelOpen, modelToolsLabel, setEnd]);

  const handleCopyLast = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Send the slash as a burst, wait long enough for Ink's tokenizer to
    // emit a keypress event for each character (not coalesce them into a
    // paste), then send Return as its own event.  The timing here is
    // empirical — 100ms is safely past Node's default stdin coalescing
    // window and well inside UI responsiveness.
    ws.send("/copy");
    setTimeout(() => {
      const s = wsRef.current;
      if (s && s.readyState === WebSocket.OPEN) s.send("\r");
    }, 100);
    setCopyState("copied");
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopyState("idle"), 1500);
    termRef.current?.focus();
  };

  const handleSend = () => {
    const ws = wsRef.current;
    const text = inputValue;
    if (!ws || ws.readyState !== WebSocket.OPEN || !text.trim()) return;
    // Send the text as a single burst so it arrives as one stdin read,
    // then send Enter after a short delay so the tokenizer sees it as a
    // separate keypress.  Without the delay the text and \r can coalesce
    // into one token (e.g. "hello\r") which parseKeypress does not
    // recognise as Return — the \r is only matched when it arrives alone.
    ws.send(text);
    setTimeout(() => {
      const s = wsRef.current;
      if (s && s.readyState === WebSocket.OPEN) s.send("\r");
    }, 100);
    setInputValue("");
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // -- Toolbar: send raw bytes to the PTY via the existing WebSocket -------
  const sendRaw = useCallback(
    (bytes: Uint8Array | string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (typeof bytes === "string") {
        const buf = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
        ws.send(buf);
      } else {
        ws.send(bytes);
      }
    },
    [],
  );

  // Scroll: synthesize SGR mouse wheel events at the viewport center so Ink
  // (the TUI) processes them as real scroll input.  Using scrollLines() only
  // moves xterm.js's viewport without notifying the PTY — Ink never learns.
  const sendWheel = useCallback(
    (direction: 1 | -1) => {
      const term = termRef.current;
      const ws = wsRef.current;
      if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
      // SGR mouse wheel: ESC [ < button ; col ; row M
      // button 0x40 = wheel-up, 0x41 = wheel-down (base 64 + 0/1)
      const cb = 0x40 | (direction === -1 ? 0 : 1);
      const col = Math.round(term.cols / 2);
      const row = Math.round(term.rows / 2);
      const seq = `\x1b[<${cb};${col};${row}M`;
      const buf = new Uint8Array(seq.length);
      for (let i = 0; i < seq.length; i++) buf[i] = seq.charCodeAt(i);
      ws.send(buf);
    },
    [],
  );
  const handleCancel = useCallback(() => {
    sendRaw(new Uint8Array([0x03]));
    termRef.current?.focus();
  }, [sendRaw]);

  // Queue-mode cycle: interrupt → queue → steer → interrupt.
  // Sends a /config set slash command so the TUI picks it up.
  const BUSY_MODES = ["interrupt", "queue", "steer"] as const;
  const [busyMode, setBusyMode] = useState<string>("interrupt");
  const handleToggleBusyMode = useCallback(() => {
    const next =
      BUSY_MODES[(BUSY_MODES.indexOf(busyMode as (typeof BUSY_MODES)[number]) + 1) % BUSY_MODES.length];
    setBusyMode(next);
    sendRaw(`/config set display.busy_input_mode ${next}`);
    setTimeout(() => {
      const s = wsRef.current;
      if (s && s.readyState === WebSocket.OPEN) s.send(new Uint8Array([0x0d]));
    }, 100);
    termRef.current?.focus();
  }, [busyMode, sendRaw]);

  // Slash command popover
  const [slashOpen, setSlashOpen] = useState(false);
  const slashAnchorRef = useRef<HTMLButtonElement | null>(null);
  const slashPopRef = useRef<HTMLDivElement | null>(null);

  const SLASH_COMMANDS: { label: string; cmd: string; desc: string }[] = [
    { label: "/queue", cmd: "/queue", desc: "View queued messages" },
    { label: "/cancel", cmd: "/cancel", desc: "Cancel current run" },
    { label: "/new", cmd: "/new", desc: "Start a new session" },
    { label: "/sessions", cmd: "/sessions", desc: "List sessions" },
    { label: "/model", cmd: "/model", desc: "Switch model" },
    { label: "/resume", cmd: "/resume", desc: "Resume a session" },
    { label: "/copy", cmd: "/copy", desc: "Copy last response" },
    { label: "/help", cmd: "/help", desc: "Show all commands" },
    { label: "/clear", cmd: "/clear", desc: "Clear the screen" },
  ];

  const handleSlashSelect = useCallback(
    (cmd: string) => {
      setSlashOpen(false);
      sendRaw(cmd);
      setTimeout(() => {
        const s = wsRef.current;
        if (s && s.readyState === WebSocket.OPEN) s.send(new Uint8Array([0x0d]));
      }, 100);
      termRef.current?.focus();
    },
    [sendRaw],
  );

  // Close slash popover on outside click
  useEffect(() => {
    if (!slashOpen) return;
    const handler = (e: MouseEvent) => {
      const pop = slashPopRef.current;
      const btn = slashAnchorRef.current;
      if (
        pop &&
        btn &&
        !pop.contains(e.target as Node) &&
        !btn.contains(e.target as Node)
      ) {
        setSlashOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [slashOpen]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const token = window.__HERMES_SESSION_TOKEN__;
    // Banner already initialised above; just bail before wiring xterm/WS.
    if (!token) {
      return;
    }

    const tierW0 = terminalTierWidthPx(host);
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      disableStdin: true,
      fontFamily:
        "'JetBrains Mono', 'Cascadia Mono', 'Fira Code', 'MesloLGS NF', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: terminalFontSizeForWidth(tierW0),
      lineHeight: terminalLineHeightForWidth(tierW0),
      letterSpacing: 0,
      fontWeight: "400",
      fontWeightBold: "700",
      macOptionIsMeta: true,
      scrollback: 10000,
      theme: TERMINAL_THEME,
    });
    termRef.current = term;

    // --- Clipboard integration ---------------------------------------
    //
    // Three independent paths all route to the system clipboard:
    //
    //   1. **Selection → Ctrl+C (or Cmd+C on macOS).**  Ink's own handler
    //      in useInputHandlers.ts turns Ctrl+C into a copy when the
    //      terminal has a selection, then emits an OSC 52 escape.  Our
    //      OSC 52 handler below decodes that escape and writes to the
    //      browser clipboard — so the flow works just like it does in
    //      `hermes --tui`.
    //
    //   2. **Ctrl/Cmd+Shift+C.**  Belt-and-suspenders shortcut that
    //      operates directly on xterm's selection, useful if the TUI
    //      ever stops listening (e.g. overlays / pickers) or if the user
    //      has selected with the mouse outside of Ink's selection model.
    //
    //   3. **Ctrl/Cmd+Shift+V.**  Reads the system clipboard and feeds
    //      it to the terminal as keyboard input.  xterm's paste() wraps
    //      it with bracketed-paste if the host has that mode enabled.
    //
    // OSC 52 reads (terminal asking to read the clipboard) are not
    // supported — that would let any content the TUI renders exfiltrate
    // the user's clipboard.
    term.parser.registerOscHandler(52, (data) => {
      // Format: "<targets>;<base64 | '?'>"
      const semi = data.indexOf(";");
      if (semi < 0) return false;
      const payload = data.slice(semi + 1);
      if (payload === "?" || payload === "") return false; // read/clear — ignore
      try {
        const binary = atob(payload);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const text = new TextDecoder("utf-8").decode(bytes);
        navigator.clipboard.writeText(text).catch((err) => {
          // Most common reason: the Clipboard API requires a user gesture.
          // This can fail when the OSC 52 response arrives outside the
          // original keydown event's activation. Log to aid debugging.
          console.warn("[dashboard clipboard] OSC 52 write failed:", err.message);
        });
      } catch (e) {
        console.warn("[dashboard clipboard] malformed OSC 52 payload");
      }
      return true;
    });

    const isMac =
      typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      // Copy: Cmd+C on macOS, Ctrl+Shift+C on other platforms. Bare Ctrl+C
      // is reserved for SIGINT to the TUI child — matches xterm / gnome-terminal /
      // konsole / Windows Terminal. Ctrl+Shift+C only copies if a selection exists;
      // without a selection it passes through to the TUI so agents can still
      // react to the keypress.
      // Paste: Cmd+Shift+V on macOS, Ctrl+Shift+V on others.
      const copyModifier = isMac ? ev.metaKey : ev.ctrlKey && ev.shiftKey;
      const pasteModifier = isMac ? ev.metaKey : ev.ctrlKey && ev.shiftKey;

      if (copyModifier && ev.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (sel) {
          // Direct writeText inside the keydown handler preserves the user
          // gesture — async round-trips through OSC 52 can lose activation
          // and fail with "Document is not focused".
          navigator.clipboard.writeText(sel).catch((err) => {
            console.warn("[dashboard clipboard] direct copy failed:", err.message);
          });
          // Clear xterm.js's highlight after copy (matches gnome-terminal).
          term.clearSelection();
          ev.preventDefault();
          return false;
        }
        // No selection → fall through so the TUI receives Ctrl+Shift+C
        // (or the bare ev if the user used a different modifier).
      }

      if (pasteModifier && ev.key.toLowerCase() === "v") {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch((err) => {
            console.warn("[dashboard clipboard] paste failed:", err.message);
          });
        ev.preventDefault();
        return false;
      }

      return true;
    });

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    term.loadAddon(new WebLinksAddon());

    term.open(host);

    // WebGL draws from a texture atlas sized with device pixels. On phones and
    // in DevTools device mode that often produces *visually* much larger cells
    // than `fontSize` suggests — users see "huge" text even at 7–9px settings.
    // The canvas/DOM renderer tracks `fontSize` faithfully; use it for narrow
    // hosts.  Wide layouts still get WebGL for crisp box-drawing.
    const useWebgl = terminalTierWidthPx(host) >= 768;
    if (useWebgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch (err) {
        console.warn(
          "[hermes-chat] WebGL renderer unavailable; falling back to default",
          err,
        );
      }
    }

    // Initial fit + resize observer.  fit.fit() reads the container's
    // current bounding box and resizes the terminal grid to match.
    //
    // The subtle bit: the dashboard has CSS transitions on the container
    // (backdrop fade-in, rounded corners settling as fonts load).  If we
    // call fit() at mount time, the bounding box we measure is often 1-2
    // cell widths off from the final size.  ResizeObserver *does* fire
    // when the container settles, but if the pixel delta happens to be
    // smaller than one cell's width, fit() computes the same integer
    // (cols, rows) as before and doesn't emit onResize — so the PTY
    // never learns the final size.  Users see truncated long lines until
    // they resize the browser window.
    //
    // We force one extra fit + explicit RESIZE send after two animation
    // frames.  rAF→rAF guarantees one layout commit between the two
    // callbacks, giving CSS transitions and font metrics time to finalize
    // before we take the authoritative measurement.
    let hostSyncRaf = 0;
    const scheduleHostSync = () => {
      if (hostSyncRaf) return;
      hostSyncRaf = requestAnimationFrame(() => {
        hostSyncRaf = 0;
        syncTerminalMetrics();
      });
    };

    let metricsDebounce: ReturnType<typeof setTimeout> | null = null;
    const syncTerminalMetrics = () => {
      // display:none hosts have clientWidth/Height = 0, which fit() turns
      // into a 1x1 terminal.  Skip entirely while hidden; the visibility
      // effect below runs another fit as soon as the tab is shown again.
      if (!host.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) {
        return;
      }
      const w = terminalTierWidthPx(host);
      const nextSize = terminalFontSizeForWidth(w);
      const nextLh = terminalLineHeightForWidth(w);
      const fontChanged =
        term.options.fontSize !== nextSize ||
        term.options.lineHeight !== nextLh;
      if (fontChanged) {
        term.options.fontSize = nextSize;
        term.options.lineHeight = nextLh;
      }
      try {
        fit.fit();
      } catch {
        return;
      }
      if (fontChanged && term.rows > 0) {
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          /* ignore */
        }
      }
      if (
        fontChanged &&
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN
      ) {
        wsRef.current.send(`\x1b[RESIZE:${term.cols};${term.rows}]`);
      }
    };
    syncMetricsRef.current = syncTerminalMetrics;

    const scheduleSyncTerminalMetrics = () => {
      if (metricsDebounce) clearTimeout(metricsDebounce);
      metricsDebounce = setTimeout(() => {
        metricsDebounce = null;
        syncTerminalMetrics();
      }, 60);
    };

    const ro = new ResizeObserver(() => scheduleHostSync());
    ro.observe(host);

    window.addEventListener("resize", scheduleSyncTerminalMetrics);
    window.visualViewport?.addEventListener("resize", scheduleSyncTerminalMetrics);
    window.visualViewport?.addEventListener("scroll", scheduleSyncTerminalMetrics);
    scheduleHostSync();
    requestAnimationFrame(() => scheduleHostSync());

    // Double-rAF authoritative fit.  On the second frame the layout has
    // committed at least once since mount; fit.fit() then reads the
    // stable container size.  We always send a RESIZE escape afterwards
    // (even if fit's cols/rows didn't change, so the PTY has the same
    // dims registered as our JS state — prevents a drift where Ink
    // thinks the terminal is one col bigger than what's on screen).
    let settleRaf1 = 0;
    let settleRaf2 = 0;
    settleRaf1 = requestAnimationFrame(() => {
      settleRaf1 = 0;
      settleRaf2 = requestAnimationFrame(() => {
        settleRaf2 = 0;
        syncTerminalMetrics();
      });
    });

    // WebSocket
    const url = buildWsUrl(token, resumeRef.current, channel);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    // Suppress banner/terminal side-effects when cleanup() calls `ws.close()`
    // (React StrictMode remount, route change) so we never write to a
    // disposed xterm or setState on an unmounted tree.
    let unmounting = false;

    ws.onopen = () => {
      setBanner(null);
      // Send the initial RESIZE immediately so Ink has *a* size to lay
      // out against on its first paint.  The double-rAF block above will
      // follow up with the authoritative measurement — at worst Ink
      // reflows once after the PTY boots, which is imperceptible.
      ws.send(`\x1b[RESIZE:${term.cols};${term.rows}]`);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        // Server only sends binary frames; a text frame means something
        // unexpected (e.g. an error message).  Write it as-is so the user
        // sees it rather than silently dropping.
        term.write(ev.data);
      } else {
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      }
    };

    ws.onclose = (ev) => {
      wsRef.current = null;
      if (unmounting) {
        return;
      }
      if (ev.code === 4401) {
        setBanner("Auth failed. Reload the page to refresh the session token.");
        return;
      }
      if (ev.code === 4403) {
        setBanner("Chat is only reachable from localhost.");
        return;
      }
      if (ev.code === 1011) {
        // Server already wrote an ANSI error frame.
        return;
      }
      term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
    };

    // Keystrokes + mouse events → PTY, with cell-level dedup for motion.
    //
    // Ink enables `\x1b[?1003h` (any-motion tracking), which asks the
    // terminal to report every mouse-move as an SGR mouse event even with
    // no button held.  xterm.js happily emits one report per pixel of
    // mouse motion; without deduping, a casual mouse-over floods Ink with
    // hundreds of redraw-triggering reports and the UI goes laggy
    // (scrolling stutters, clicks land on stale positions by the time
    // Ink finishes processing the motion backlog).
    //
    // We keep track of the last cell we reported a motion for.  Press,
    // release, and wheel events always pass through; motion events only
    // pass through if the cell changed.  Parsing is cheap — SGR reports
    // are short literal strings.
    // eslint-disable-next-line no-control-regex -- intentional ESC byte in xterm SGR mouse report parser
    const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
    let lastMotionCell = { col: -1, row: -1 };
    let lastMotionCb = -1;

    // Selection-mode tracking: when the user is dragging to select text in the
    // terminal, we must NOT forward mouse events to the TUI (Ink).  Ink
    // interprets mouse reports as hover/click on its interactive widgets and
    // will steal focus, clear the selection, or trigger side-effects.
    // We detect selection by watching for a mouse-down → drag → mouse-up
    // sequence on the host element.  While selecting, only wheel events are
    // forwarded (so the user can still scroll during a selection).
    let selecting = false;
    let mouseDownOnHost = false;
    const onHostMouseDown = (e: MouseEvent) => {
      // Only left button, no modifiers → likely a selection drag
      if (e.button === 0 && !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey) {
        mouseDownOnHost = true;
        selecting = false; // will become true on first drag
      }
    };
    const onHostMouseMove = () => {
      if (mouseDownOnHost) selecting = true;
    };
    const onHostMouseUp = () => {
      // If mouse went down and up without significant movement, it was a
      // click (not a drag-select) — keep selecting=false so the click
      // forwards normally.
      mouseDownOnHost = false;
      // Delay clearing so the onData handler sees selecting=true for any
      // trailing mouse-up event from xterm.
      setTimeout(() => { selecting = false; }, 50);
    };
    host.addEventListener("mousedown", onHostMouseDown);
    host.addEventListener("mousemove", onHostMouseMove);
    host.addEventListener("mouseup", onHostMouseUp);

    const onDataDisposable = term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      const m = SGR_MOUSE_RE.exec(data);
      if (m) {
        const cb = parseInt(m[1], 10);
        const col = parseInt(m[2], 10);
        const row = parseInt(m[3], 10);
        const released = m[4] === "m";
        // Motion events have bit 0x20 (32) set in the button code.
        // Wheel events have bit 0x40 (64); always forward wheel.
        const isMotion = (cb & 0x20) !== 0 && (cb & 0x40) === 0;
        const isWheel = (cb & 0x40) !== 0;

        // During text selection, suppress all mouse reports except wheel.
        // This prevents Ink from reacting to hover/click during drag-select.
        if (selecting && !isWheel) {
          // Reset dedup state so the next post-selection event isn't dropped
          lastMotionCell = { col: -1, row: -1 };
          lastMotionCb = -1;
          return;
        }

        if (isMotion && !isWheel && !released) {
          if (
            col === lastMotionCell.col &&
            row === lastMotionCell.row &&
            cb === lastMotionCb
          ) {
            return; // same cell + same button state; skip redundant report
          }
          lastMotionCell = { col, row };
          lastMotionCb = cb;
        } else {
          // Non-motion event (press, release, wheel) — reset dedup state
          // so the next motion after this always reports.
          lastMotionCell = { col: -1, row: -1 };
          lastMotionCb = -1;
        }
      }

      // Send as binary (Uint8Array) instead of a JS string so that
      // multi-byte UTF-8 characters and raw control bytes arrive at the
      // server without a text-encoding round-trip that can split or
      // corrupt partial sequences across WebSocket frames.
      const buf = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        buf[i] = data.charCodeAt(i);
      }
      ws.send(buf);
    });

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`\x1b[RESIZE:${cols};${rows}]`);
      }
    });

    // Note: we do NOT call term.focus() here — the terminal is display-only.
    // User input goes through the separate input box below.

    return () => {
      unmounting = true;
      host.removeEventListener("mousedown", onHostMouseDown);
      host.removeEventListener("mousemove", onHostMouseMove);
      host.removeEventListener("mouseup", onHostMouseUp);
      syncMetricsRef.current = null;
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      if (metricsDebounce) clearTimeout(metricsDebounce);
      window.removeEventListener("resize", scheduleSyncTerminalMetrics);
      window.visualViewport?.removeEventListener(
        "resize",
        scheduleSyncTerminalMetrics,
      );
      window.visualViewport?.removeEventListener(
        "scroll",
        scheduleSyncTerminalMetrics,
      );
      ro.disconnect();
      if (hostSyncRaf) cancelAnimationFrame(hostSyncRaf);
      if (settleRaf1) cancelAnimationFrame(settleRaf1);
      if (settleRaf2) cancelAnimationFrame(settleRaf2);
      ws.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
        copyResetRef.current = null;
      }
    };
  }, [channel]);

  // When the user returns to the chat tab (isActive: false → true), the
  // terminal host just transitioned from display:none to display:flex.
  // ResizeObserver won't fire on that kind of style-driven box change —
  // xterm thinks its grid is still whatever it was when the tab was
  // hidden (or 0×0, if it was hidden before first fit).  Force a refit
  // after two animation frames so layout has committed.
  //
  // Focus handling: we only steal focus back into the terminal when
  // nothing else inside ChatPage was holding it (typically the first
  // activation after mount, where document.activeElement is <body>; or
  // a return after the user had been typing in the terminal, where
  // focus was already on the xterm textarea before the tab got hidden
  // and has since fallen back to <body>).  If the user had clicked
  // into the sidebar (model picker, tool-call entry) before switching
  // tabs, we must not yank focus away from wherever they left it when
  // they come back — that's a surprise and an a11y foot-gun.
  useEffect(() => {
    if (!isActive) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf1 = 0;
      raf2 = requestAnimationFrame(() => {
        raf2 = 0;
        syncMetricsRef.current?.();
        const host = hostRef.current;
        const active = typeof document !== "undefined"
          ? document.activeElement
          : null;
        const focusIsElsewhereInChatPage =
          active !== null &&
          active !== document.body &&
          host !== null &&
          !host.contains(active);
        if (!focusIsElsewhereInChatPage) {
          inputRef.current?.focus();
        }
      });
    });
    return () => {
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [isActive]);

  // Layout:
  //   outer flex column — sits inside the dashboard's content area
  //   row split — terminal pane (flex-1) + sidebar (fixed width, lg+)
  //   terminal wrapper — rounded, dark, padded — the "terminal window"
  //   floating copy button — bottom-right corner, transparent with a
  //     subtle border; stays out of the way until hovered.  Sends
  //     `/copy\n` to Ink, which emits OSC 52 → our clipboard handler.
  //   sidebar — ChatSidebar opens its own JSON-RPC sidecar; renders
  //     model badge, tool-call list, model picker. Best-effort: if the
  //     sidecar fails to connect the terminal pane keeps working.
  //
  // `normal-case` opts out of the dashboard's global `uppercase` rule on
  // the root `<div>` in App.tsx — terminal output must preserve case.
  //
  // Mobile model/tools sheet is portaled to `document.body` so it stacks
  // above the app sidebar (`z-50`) and mobile chrome (`z-40`).  The main
  // dashboard column uses `relative z-2`, which traps `position:fixed`
  // descendants below those layers (see Toast.tsx).
  const mobileModelToolsPortal =
    isActive &&
    narrow &&
    portalRoot &&
    createPortal(
      <>
        {mobilePanelOpen && (
          <Button
            ghost
            aria-label={t.app.closeModelTools}
            onClick={closeMobilePanel}
            className={cn(
              "fixed inset-0 z-[55] p-0 block",
              "bg-black/60 backdrop-blur-sm",
            )}
          />
        )}

        <div
          id="chat-side-panel"
          role="complementary"
          aria-label={modelToolsLabel}
          className={cn(
            "font-mondwest fixed top-0 right-0 z-[60] flex h-dvh max-h-dvh w-64 min-w-0 flex-col antialiased",
            "border-l border-current/20 text-midground",
            "bg-background-base/95 backdrop-blur-sm",
            "transition-transform duration-200 ease-out",
            "[background:var(--component-sidebar-background)]",
            "[clip-path:var(--component-sidebar-clip-path)]",
            "[border-image:var(--component-sidebar-border-image)]",
            mobilePanelOpen
              ? "translate-x-0"
              : "pointer-events-none translate-x-full",
          )}
        >
          <div
            className={cn(
              "flex h-14 shrink-0 items-center justify-between gap-2 border-b border-current/20 px-5",
            )}
          >
            <Typography
              className="font-bold text-[1.125rem] leading-[0.95] tracking-[0.0525rem] text-midground"
              style={{ mixBlendMode: "plus-lighter" }}
            >
              {t.app.modelToolsSheetTitle}
              <br />
              {t.app.modelToolsSheetSubtitle}
            </Typography>

            <Button
              ghost
              size="icon"
              onClick={closeMobilePanel}
              aria-label={t.app.closeModelTools}
              className="text-midground/70 hover:text-midground"
            >
              <X />
            </Button>
          </div>

          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overflow-x-hidden",
              "border-t border-current/10",
            )}
          >
            <ChatSidebar channel={channel} />
          </div>
        </div>
      </>,
      portalRoot,
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 normal-case">
      <PluginSlot name="chat:top" />
      {mobileModelToolsPortal}

      {banner && (
        <div className="border border-warning/50 bg-warning/10 text-warning px-3 py-2 text-xs tracking-wide">
          {banner}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row lg:gap-3">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div
            className={cn(
              "relative flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg",
              "p-2 sm:p-3",
            )}
            style={{
              backgroundColor: TERMINAL_THEME.background,
              boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
            }}
          >
            <div
              ref={hostRef}
              className="hermes-chat-xterm-host min-h-0 min-w-0 flex-1"
              onContextMenu={(e) => e.preventDefault()}
              style={{ userSelect: "text" }}
            />

            <Button
              ghost
              onClick={handleCopyLast}
              title="Copy last assistant response as raw markdown"
              aria-label="Copy last assistant response"
              className={cn(
                "absolute z-10",
                "rounded border border-current/30",
                "bg-black/20 backdrop-blur-sm",
                "opacity-60 hover:opacity-100 hover:border-current/60",
                "transition-opacity duration-150 normal-case font-normal tracking-normal",
                "bottom-2 right-2 px-2 py-1 text-[0.65rem] sm:bottom-3 sm:right-3 sm:px-2.5 sm:py-1.5 sm:text-xs",
                "lg:bottom-4 lg:right-4",
              )}
              style={{ color: TERMINAL_THEME.foreground }}
            >
              <span className="inline-flex items-center gap-1.5">
                <Copy className="h-3 w-3 shrink-0" />
                <span className="hidden min-[400px]:inline tracking-wide">
                  {copyState === "copied" ? "copied" : "copy last response"}
                </span>
              </span>
            </Button>
          </div>

          {/* Toolbar: Cancel, nav keys, scroll, queue mode, slash commands */}
          <div
            className={cn(
              "flex flex-wrap items-center gap-1 rounded-lg px-2 py-1.5",
              "border border-current/20",
            )}
            style={{ backgroundColor: TERMINAL_THEME.background }}
          >
            {/* Cancel / Interrupt */}
            <button
              onClick={handleCancel}
              title="Cancel current run (Ctrl+C)"
              aria-label="Cancel current run"
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-1 text-[0.65rem] font-medium",
                "border border-current/20 text-midground/70",
                "hover:text-red-400 hover:border-red-400/40 hover:bg-red-400/10",
                "transition-colors duration-150",
              )}
            >
              <StopCircle className="h-3 w-3 shrink-0" />
              <span className="hidden min-[400px]:inline tracking-wide">Cancel</span>
            </button>

            {/* Nav cluster: Arrow Up, Down, Left, Right, Enter, Esc */}
            <div className="flex items-center gap-0.5 border-l border-current/10 pl-1 ml-0.5">
              {([
                { code: "\x1b[A", label: "↑", title: "Arrow Up" },
                { code: "\x1b[B", label: "↓", title: "Arrow Down" },
                { code: "\x1b[D", label: "←", title: "Arrow Left" },
                { code: "\x1b[C", label: "→", title: "Arrow Right" },
              ] as const).map(({ code, label, title }) => (
                <button
                  key={code}
                  onClick={() => sendRaw(code)}
                  title={title}
                  aria-label={title}
                  className={cn(
                    "rounded px-1.5 py-1 text-[0.6rem] font-mono font-medium leading-none",
                    "text-midground/60 hover:text-midground hover:bg-midground/10",
                    "transition-colors duration-100",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-0.5 border-l border-current/10 pl-1 ml-0.5">
              <button
                onClick={() => sendRaw("\r")}
                title="Enter / Select"
                aria-label="Enter"
                className={cn(
                  "rounded px-2 py-1 text-[0.6rem] font-medium leading-none",
                  "text-midground/60 hover:text-midground hover:bg-midground/10",
                  "transition-colors duration-100",
                )}
              >
                Enter
              </button>
              <button
                onClick={() => sendRaw("\x1b")}
                title="Escape / Back"
                aria-label="Escape"
                className={cn(
                  "rounded px-2 py-1 text-[0.6rem] font-medium leading-none",
                  "text-midground/60 hover:text-midground hover:bg-midground/10",
                  "transition-colors duration-100",
                )}
              >
                Esc
              </button>
            </div>

            {/* Scroll cluster */}
            <div className="flex items-center gap-0.5 border-l border-current/10 pl-1 ml-0.5">
              <button
                onClick={() => sendWheel(-1)}
                title="Scroll Up"
                aria-label="Scroll Up"
                className={cn(
                  "rounded px-1.5 py-1 text-[0.6rem] font-mono font-medium leading-none",
                  "text-midground/60 hover:text-midground hover:bg-midground/10",
                  "transition-colors duration-100",
                )}
              >
                ⇡
              </button>
              <button
                onClick={() => sendWheel(1)}
                title="Scroll Down"
                aria-label="Scroll Down"
                className={cn(
                  "rounded px-1.5 py-1 text-[0.6rem] font-mono font-medium leading-none",
                  "text-midground/60 hover:text-midground hover:bg-midground/10",
                  "transition-colors duration-100",
                )}
              >
                ⇣
              </button>
            </div>

            {/* Approve / Reject (Y/N) */}
            <div className="flex items-center gap-0.5 border-l border-current/10 pl-1 ml-0.5">
              <button
                onClick={() => {
                  sendRaw("y");
                  setTimeout(() => {
                    const s = wsRef.current;
                    if (s && s.readyState === WebSocket.OPEN) s.send(new Uint8Array([0x0d]));
                  }, 80);
                }}
                title="Approve / Yes"
                aria-label="Approve"
                className={cn(
                  "rounded px-2 py-1 text-[0.6rem] font-medium leading-none",
                  "text-green-500/70 hover:text-green-400 hover:bg-green-400/10",
                  "transition-colors duration-100",
                )}
              >
                ✓ Yes
              </button>
              <button
                onClick={() => {
                  sendRaw("n");
                  setTimeout(() => {
                    const s = wsRef.current;
                    if (s && s.readyState === WebSocket.OPEN) s.send(new Uint8Array([0x0d]));
                  }, 80);
                }}
                title="Reject / No"
                aria-label="Reject"
                className={cn(
                  "rounded px-2 py-1 text-[0.6rem] font-medium leading-none",
                  "text-red-500/70 hover:text-red-400 hover:bg-red-400/10",
                  "transition-colors duration-100",
                )}
              >
                ✗ No
              </button>
            </div>

            {/* Spacer */}
            <div className="flex-1 min-w-2" />

            {/* Queue-mode toggle */}
            <button
              onClick={handleToggleBusyMode}
              title={`Input while busy: ${busyMode} (click to cycle)`}
              aria-label={`Input while busy: ${busyMode}`}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-1 text-[0.65rem] font-medium",
                "border border-current/20",
                busyMode === "interrupt" && "text-midground/70 hover:text-amber-400 hover:border-amber-400/40 hover:bg-amber-400/10",
                busyMode === "queue" && "text-blue-400/80 border-blue-400/30 bg-blue-400/5 hover:text-blue-300 hover:border-blue-400/50",
                busyMode === "steer" && "text-purple-400/80 border-purple-400/30 bg-purple-400/5 hover:text-purple-300 hover:border-purple-400/50",
                "transition-colors duration-150",
              )}
            >
              <ListOrdered className="h-3 w-3 shrink-0" />
              <span className="hidden min-[400px]:inline tracking-wide">{busyMode}</span>
            </button>

            {/* Slash commands popover anchor */}
            <div className="relative">
              <button
                ref={slashAnchorRef}
                onClick={() => setSlashOpen((o) => !o)}
                title="Slash commands"
                aria-label="Slash commands"
                aria-expanded={slashOpen}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-2 py-1 text-[0.65rem] font-medium",
                  "border border-current/20 text-midground/70",
                  "hover:text-midground hover:border-current/40",
                  slashOpen && "text-midground border-current/40 bg-midground/5",
                  "transition-colors duration-150",
                )}
              >
                <SquareTerminal className="h-3 w-3 shrink-0" />
                <span className="hidden min-[400px]:inline tracking-wide">/</span>
              </button>

              {slashOpen && (
                <div
                  ref={slashPopRef}
                  role="listbox"
                  aria-label="Slash commands"
                  className={cn(
                    "absolute bottom-full right-0 mb-2 w-64 max-h-72 overflow-y-auto",
                    "rounded-lg border border-current/20 shadow-xl",
                    "bg-background-base/95 backdrop-blur-sm",
                    "py-1 z-50",
                  )}
                  style={{ backgroundColor: TERMINAL_THEME.background }}
                >
                  <div className="px-3 py-1.5 text-[0.6rem] font-semibold uppercase tracking-widest text-current/30">
                    Commands
                  </div>
                  {SLASH_COMMANDS.map((item) => (
                    <button
                      key={item.cmd}
                      role="option"
                      onClick={() => handleSlashSelect(item.cmd)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                        "text-[0.7rem] transition-colors duration-100",
                        "hover:bg-midground/10 text-midground/80 hover:text-midground",
                      )}
                    >
                      <span className="font-mono font-medium shrink-0">{item.label}</span>
                      <span className="text-current/40 truncate">{item.desc}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Decoupled text input — only this box accepts keyboard input.
              Text is sent cleanly to the PTY on Enter, bypassing xterm.js
              entirely so no escape sequences or terminal artifacts can bleed
              into the input area. */}
          <div
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-2",
              "border border-current/20",
            )}
            style={{ backgroundColor: TERMINAL_THEME.background }}
          >
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Type a message…"
              className={cn(
                "min-w-0 flex-1 bg-transparent text-sm outline-none",
                "placeholder:text-current/30",
              )}
              style={{ color: TERMINAL_THEME.foreground }}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              onClick={handleSend}
              disabled={!inputValue.trim()}
              className={cn(
                "shrink-0 rounded px-2.5 py-1 text-xs font-medium",
                "border border-current/20",
                "transition-colors duration-150",
                inputValue.trim()
                  ? "text-midground/80 hover:text-midground hover:bg-midground/10"
                  : "text-current/15 cursor-not-allowed",
              )}
            >
              Send
            </button>
          </div>
        </div>

        {!narrow && (
          <div
            id="chat-side-panel"
            role="complementary"
            aria-label={modelToolsLabel}
            className="flex min-h-0 shrink-0 flex-col lg:h-full lg:w-80"
          >
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
              <ChatSidebar channel={channel} />
            </div>
          </div>
        )}
      </div>
      <PluginSlot name="chat:bottom" />
    </div>
  );
}

declare global {
  interface Window {
    __HERMES_SESSION_TOKEN__?: string;
  }
}
