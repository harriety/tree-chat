import { memo, useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

import { MindmapView } from "./components/MindmapView";
import { TreeView } from "./components/TreeView";
import {
  addChild,
  appendMessage,
  createEmptyTree,
  deleteSubtree,
  makeId,
  renameNode,
  setActiveNode,
  toggleCollapse,
} from "./core/tree";
import { sendChat, type LLMProvider } from "./services/llm";
import type { ChatNode, ChatTree, Message } from "./types/chat";

const STORAGE_KEY = "tree-chat:tree";
const PROVIDER_KEY = "tree-chat:provider";
const BACKUP_KEY = "tree-chat:backups";
const MAX_BACKUPS = 5;
const BACKUP_INTERVAL_MS = 2 * 60 * 1000;

type DeletedSnapshot = {
  rootId: string;
  parentId: string | null;
  parentIndex: number;
  nodes: Record<string, ChatNode>;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatMarkdownToHtml = (value: string) => {
  const formatInline = (text: string) => {
    const formatText = (raw: string) =>
      escapeHtml(raw)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>");

    const renderInlineMath = (raw: string) => {
      let out = "";
      let i = 0;

      while (i < raw.length) {
        // Prefer \(...\) if present (common LLM output)
        const openParen = raw.indexOf("\\(", i);
        const openDollar = raw.indexOf("$", i);

        const useParen =
          openParen !== -1 && (openDollar === -1 || openParen < openDollar);

        const start = useParen ? openParen : openDollar;
        if (start === -1) {
          out += formatText(raw.slice(i));
          break;
        }

        if (!useParen) {
          // Escaped dollar: \$
          if (start > 0 && raw[start - 1] === "\\") {
            out += formatText(raw.slice(i, start - 1));
            out += formatText("$");
            i = start + 1;
            continue;
          }

          // Don't treat $$ as inline math here (block math is handled earlier)
          if (raw[start + 1] === "$") {
            out += formatText(raw.slice(i, start + 2));
            i = start + 2;
            continue;
          }
        }

        const close = useParen ? "\\)" : "$";
        const openLen = useParen ? 2 : 1;
        let end = raw.indexOf(close, start + openLen);
        while (!useParen && end !== -1 && raw[end - 1] === "\\") {
          end = raw.indexOf(close, end + 1);
        }

        if (end === -1) {
          out += formatText(raw.slice(i));
          break;
        }

        out += formatText(raw.slice(i, start));
        const expr = raw.slice(start + openLen, end).trim();
        const looksLikeMath = /[\\{}_^=]|[A-Za-z]/.test(expr);

        if (expr && looksLikeMath) {
          const html = katex.renderToString(expr, {
            displayMode: false,
            throwOnError: false,
            strict: "ignore",
          });
          out += `<span class="chat-md-imath">${html}</span>`;
        } else {
          const closeLen = useParen ? 2 : 1;
          out += formatText(raw.slice(start, end + closeLen));
        }

        i = end + (useParen ? 2 : 1);
      }

      return out;
    };

    const parts: Array<{ type: "text" | "code"; value: string }> = [];
    let lastIndex = 0;
    for (const match of text.matchAll(/`([^`]+)`/g)) {
      const index = match.index ?? 0;
      if (index > lastIndex) {
        parts.push({ type: "text", value: text.slice(lastIndex, index) });
      }
      parts.push({ type: "code", value: match[1] });
      lastIndex = index + match[0].length;
    }
    if (lastIndex < text.length) {
      parts.push({ type: "text", value: text.slice(lastIndex) });
    }

    const rendered = parts.map((part) => {
      if (part.type === "code") {
        return `<code>${escapeHtml(part.value)}</code>`;
      }

      return renderInlineMath(part.value);
    });

    return rendered.join("");
  };

  const normalizeText = (text: string) =>
    text
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const parts = normalizeText(value).split("```");
  const htmlParts = parts.map((part, index) => {
    if (index % 2 === 1) {
      const code = part.replace(/^\n+|\n+$/g, "");
      return `<pre><code>${escapeHtml(code)}</code></pre>`;
    }

    const mathBlocks: string[] = [];
    const withBlockMathTokens = normalizeText(part)
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, expr: string) => {
        const html = katex.renderToString(String(expr).trim(), {
          displayMode: true,
          throwOnError: false,
          strict: "ignore",
        });
        mathBlocks.push(html);
        return `\n@@BMATH${mathBlocks.length - 1}@@\n`;
      })
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, expr: string) => {
        const html = katex.renderToString(String(expr).trim(), {
          displayMode: true,
          throwOnError: false,
          strict: "ignore",
        });
        mathBlocks.push(html);
        return `\n@@BMATH${mathBlocks.length - 1}@@\n`;
      });

    const lines = normalizeText(withBlockMathTokens).split("\n");
    const blocks: string[] = [];

    let paragraph: string[] = [];
    let listItems: string[] = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      blocks.push(`<p>${paragraph.map(formatInline).join("<br/>")}</p>`);
      paragraph = [];
    };

    const flushList = () => {
      if (!listItems.length) return;
      blocks.push(
        `<ul>${listItems.map((li) => `<li>${formatInline(li)}</li>`).join("")}</ul>`
      );
      listItems = [];
    };

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) {
        flushList();
        flushParagraph();
        continue;
      }

      const mathTokenMatch = /^@@BMATH(\d+)@@$/.exec(trimmed.trim());
      if (mathTokenMatch) {
        flushList();
        flushParagraph();
        const idx = Number(mathTokenMatch[1]);
        const html = mathBlocks[idx] || "";
        if (html) blocks.push(`<div class="chat-md-math">${html}</div>`);
        continue;
      }

      const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (headingMatch) {
        flushList();
        flushParagraph();
        const level = headingMatch[1].length;
        const text = headingMatch[2];
        blocks.push(
          `<div class="chat-md-h chat-md-h${level}">${formatInline(text)}</div>`
        );
        continue;
      }

      const listMatch = /^[-*]\s+(.+)$/.exec(trimmed);
      if (listMatch) {
        flushParagraph();
        listItems.push(listMatch[1]);
        continue;
      }

      flushList();
      paragraph.push(trimmed);
    }
    flushList();
    flushParagraph();

    return blocks.join("");
  });

  return htmlParts.join("");
};

const ChatMessageContent = memo(function ChatMessageContent({
  content,
}: {
  content: string;
}) {
  const html = useMemo(() => formatMarkdownToHtml(content), [content]);
  return (
    <div className="chat-md" style={{ lineHeight: 1.5 }} dangerouslySetInnerHTML={{ __html: html }} />
  );
});

function loadTreeFromStorage(): ChatTree {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyTree();
    const parsed = JSON.parse(raw) as ChatTree;
    if (!parsed?.rootId || !parsed?.activeNodeId || !parsed?.nodes) {
      return createEmptyTree();
    }
    return parsed;
  } catch (err) {
    console.warn("Failed to load tree from localStorage", err);
    return createEmptyTree();
  }
}

export default function App() {
  const [tree, setTree] = useState<ChatTree>(() => loadTreeFromStorage());
  const [view, setView] = useState<"tree" | "mindmap">("tree");
  const [input, setInput] = useState("");

  const [provider, setProvider] = useState<LLMProvider>(() => {
    const saved = localStorage.getItem(PROVIDER_KEY);
    return saved === "deepseek" || saved === "gemini" ? saved : "openai";
  });

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<{
    nodeId: string;
    messages: Message[];
    provider: LLMProvider;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [lastDeleted, setLastDeleted] = useState<DeletedSnapshot | null>(null);
  const [autoRenameId, setAutoRenameId] = useState<string | null>(null);

  const importInputRef = useRef<HTMLInputElement | null>(null);
  const lastBackupAtRef = useRef(0);

  const [searchText, setSearchText] = useState("");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");

  const activeNode = tree.nodes[tree.activeNodeId];

  const pathToRoot = useMemo(() => {
    const path: ChatNode[] = [];
    let cur = activeNode;
    while (cur) {
      path.push(cur);
      if (!cur.parentId) break;
      cur = tree.nodes[cur.parentId];
    }
    return path.reverse();
  }, [tree, activeNode]);

  const filteredNodeIds = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    const fromMs = fromTime ? new Date(fromTime).getTime() : null;
    const toMs = toTime ? new Date(toTime).getTime() : null;
    const hasQuery = query.length > 0;
    const hasTime = Boolean(fromMs || toMs);

    if (!hasQuery && !hasTime) return null;

    const isInRange = (ts: number) => {
      if (fromMs && ts < fromMs) return false;
      if (toMs && ts > toMs) return false;
      return true;
    };

    const matches = new Set<string>();
    for (const node of Object.values(tree.nodes)) {
      let ok = true;

      if (hasQuery) {
        const titleMatch = node.title.toLowerCase().includes(query);
        const messageMatch = node.messages.some((m) =>
          m.content.toLowerCase().includes(query)
        );
        ok = titleMatch || messageMatch;
      }

      if (ok && hasTime) {
        const nodeTimeMatch = isInRange(node.createdAt) || isInRange(node.updatedAt);
        const messageTimeMatch = node.messages.some((m) => isInRange(m.createdAt));
        ok = nodeTimeMatch || messageTimeMatch;
      }

      if (ok) {
        matches.add(node.id);
        let cur = node;
        while (cur.parentId) {
          const parent = tree.nodes[cur.parentId];
          if (!parent) break;
          matches.add(parent.id);
          cur = parent;
        }
      }
    }

    matches.add(tree.rootId);
    return matches;
  }, [tree, searchText, fromTime, toTime]);

  useEffect(() => {
    try {
      localStorage.setItem(PROVIDER_KEY, provider);
    } catch (err) {
      console.warn("Failed to save provider", err);
    }
  }, [provider]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tree));
      } catch (err) {
        console.warn("Failed to save tree", err);
      }

      const now = Date.now();
      if (now - lastBackupAtRef.current < BACKUP_INTERVAL_MS) return;
      lastBackupAtRef.current = now;

      try {
        const raw = localStorage.getItem(BACKUP_KEY);
        const parsed = raw
          ? (JSON.parse(raw) as Array<{ savedAt: number; tree: ChatTree }>)
          : [];
        const backups = Array.isArray(parsed) ? parsed : [];
        backups.push({ savedAt: now, tree });
        localStorage.setItem(BACKUP_KEY, JSON.stringify(backups.slice(-MAX_BACKUPS)));
      } catch (err) {
        console.warn("Failed to save backup", err);
      }
    }, 300);
    return () => window.clearTimeout(handle);
  }, [tree]);

  const captureDeletedSubtree = (t: ChatTree, nodeId: string): DeletedSnapshot | null => {
    const node = t.nodes[nodeId];
    if (!node || nodeId === t.rootId) return null;
    const parentId = node.parentId;
    const parent = parentId ? t.nodes[parentId] : undefined;
    const parentIndex = parent?.childrenIds.indexOf(nodeId) ?? -1;

    const nodes: Record<string, ChatNode> = {};
    const stack = [nodeId];
    while (stack.length) {
      const curId = stack.pop()!;
      const cur = t.nodes[curId];
      if (!cur || nodes[curId]) continue;
      nodes[curId] = cur;
      for (const cid of cur.childrenIds) stack.push(cid);
    }
    return { rootId: nodeId, parentId, parentIndex, nodes };
  };

  const restoreDeletedSubtree = (t: ChatTree, snapshot: DeletedSnapshot): ChatTree => {
    const parentId = snapshot.parentId;
    if (!parentId) return t;
    const parent = t.nodes[parentId];
    if (!parent) return t;

    const nextNodes = { ...t.nodes, ...snapshot.nodes };
    const nextChildren = parent.childrenIds.slice();
    if (!nextChildren.includes(snapshot.rootId)) {
      const insertAt =
        snapshot.parentIndex >= 0 && snapshot.parentIndex <= nextChildren.length
          ? snapshot.parentIndex
          : nextChildren.length;
      nextChildren.splice(insertAt, 0, snapshot.rootId);
    }

    return {
      ...t,
      activeNodeId: snapshot.rootId,
      nodes: {
        ...nextNodes,
        [parentId]: { ...parent, childrenIds: nextChildren, updatedAt: Date.now() },
      },
    };
  };

  const cancelRequest = () => {
    if (!isGenerating) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setIsGenerating(false);
  };

  const sendUserMessage = async () => {
    const text = input.trim();
    if (!text || !activeNode || isGenerating) return;

    const nodeId = activeNode.id;
    const userMessage: Message = {
      id: makeId(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    const requestMessages = [...activeNode.messages, userMessage];

    setTree((t) => appendMessage(t, t.activeNodeId, "user", text));
    setInput("");
    setError(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true);
    setLastRequest({ nodeId, messages: requestMessages, provider });

    try {
      const response = await sendChat({
        messages: requestMessages,
        signal: controller.signal,
        provider,
      });
      setTree((t) => appendMessage(t, nodeId, "assistant", response));
      setIsGenerating(false);
      setLastRequest(null);
    } catch (err) {
      const isAbort =
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError");
      if (!isAbort) {
        setError(err instanceof Error ? err.message : "Unknown error.");
      }
      setIsGenerating(false);
    }
  };

  const retryLastRequest = async () => {
    if (!lastRequest || isGenerating) return;
    const nodeExists = tree.nodes[lastRequest.nodeId];
    if (!nodeExists) {
      setError("That thread no longer exists.");
      setLastRequest(null);
      return;
    }

    setError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true);

    try {
      const response = await sendChat({
        messages: lastRequest.messages,
        signal: controller.signal,
        provider: lastRequest.provider,
      });
      setTree((t) => appendMessage(t, lastRequest.nodeId, "assistant", response));
      setIsGenerating(false);
      setLastRequest(null);
    } catch (err) {
      const isAbort =
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError");
      if (!isAbort) {
        setError(err instanceof Error ? err.message : "Unknown error.");
      }
      setIsGenerating(false);
    }
  };

  const autoRenameNode = async (nodeId: string) => {
    const node = tree.nodes[nodeId];
    if (!node) return;
    if (autoRenameId) return;
    if (!node.messages.length) {
      window.alert("No messages to summarize for a title.");
      return;
    }

    setAutoRenameId(nodeId);
    const content = node.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")
      .slice(0, 4000);
    const now = Date.now();
    const promptMessages: Message[] = [
      {
        id: makeId(),
        role: "system",
        content:
          "You are a naming assistant. Generate a short, clear title (max 30 chars). Return only the title.",
        createdAt: now,
      },
      {
        id: makeId(),
        role: "user",
        content,
        createdAt: now,
      },
    ];

    try {
      const response = await sendChat({ messages: promptMessages, provider });
      const title = response.replace(/\s+/g, " ").trim().slice(0, 60);
      if (!title) throw new Error("Empty title from model.");
      setTree((t) => renameNode(t, nodeId, title));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Auto rename failed.");
    } finally {
      setAutoRenameId(null);
    }
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
      }}
    >
      <aside
        style={{
          borderRight: "1px solid hsl(var(--border-subtle))",
          padding: 16,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          background: "hsl(var(--bg-secondary))",
        }}
      >
        <details
          className="sidebar-section"
          style={{
            marginBottom: 16,
          }}
        >
          <summary
            style={{
              listStyle: "none",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 14,
              color: "hsl(var(--text-primary))",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 18 }}>⚙️</span> Filters & Tools
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search title or content…"
              className="input-fancy"
              style={{ width: "100%" }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="datetime-local"
                value={fromTime}
                onChange={(e) => setFromTime(e.target.value)}
                className="input-fancy"
                style={{ flex: 1, padding: "6px 10px" }}
                title="From"
              />
              <input
                type="datetime-local"
                value={toTime}
                onChange={(e) => setToTime(e.target.value)}
                className="input-fancy"
                style={{ flex: 1, padding: "6px 10px" }}
                title="To"
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  const blob = new Blob([JSON.stringify(tree, null, 2)], {
                    type: "application/json",
                  });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `tree-chat-${Date.now()}.json`;
                  link.click();
                  URL.revokeObjectURL(url);
                }}
                style={{
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.15)",
                  background: "white",
                  padding: "6px 10px",
                  cursor: "pointer",
                }}
              >
                Export JSON
              </button>
              <button
                onClick={() => importInputRef.current?.click()}
                style={{
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.15)",
                  background: "white",
                  padding: "6px 10px",
                  cursor: "pointer",
                }}
              >
                Import JSON
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const text = await file.text();
                    const parsed = JSON.parse(text) as ChatTree;
                    if (!parsed?.rootId || !parsed?.activeNodeId || !parsed?.nodes) {
                      throw new Error("Invalid JSON structure");
                    }
                    if (!parsed.nodes[parsed.rootId]) {
                      throw new Error("Root node missing");
                    }
                    setTree(parsed);
                    setError(null);
                  } catch (err) {
                    window.alert(err instanceof Error ? err.message : "Import failed");
                  } finally {
                    e.target.value = "";
                  }
                }}
              />
            </div>
          </div>
        </details>

        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button
            onClick={() => setView("tree")}
            className={view === "tree" ? "btn-primary" : "btn-secondary"}
            style={{
              flex: 1,
              borderRadius: 10,
              padding: "10px 12px",
              cursor: "pointer",
              border: view === "tree" ? "none" : "1px solid hsl(var(--border-med))",
            }}
          >
            Tree View
          </button>
          <button
            onClick={() => setView("mindmap")}
            className={view === "mindmap" ? "btn-primary" : "btn-secondary"}
            style={{
              flex: 1,
              borderRadius: 10,
              padding: "10px 12px",
              cursor: "pointer",
              border: view === "mindmap" ? "none" : "1px solid hsl(var(--border-med))",
              background: view === "mindmap" ? "linear-gradient(135deg, #1d4ed8, #3b82f6)" : "white",
            }}
          >
            Mindmap View
          </button>
          <button
            onClick={() => {
              const ok = window.confirm("Reset tree and clear local data?");
              if (!ok) return;
              localStorage.removeItem(STORAGE_KEY);
              setTree(createEmptyTree());
            }}
            className="btn-secondary"
            style={{
              borderRadius: 10,
              padding: "10px 12px",
              cursor: "pointer",
              flex: 0.4,
            }}
            title="Clear local storage and reset tree"
          >
            Reset
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          {view === "tree" ? (
            <TreeView
              tree={tree}
              visibleNodeIds={filteredNodeIds}
              autoRenameId={autoRenameId}
              onAutoRename={autoRenameNode}
              onSelect={(id) => setTree((t) => setActiveNode(t, id))}
              onAddChild={(parentId) => setTree((t) => addChild(t, parentId))}
              onToggleCollapse={(id) => setTree((t) => toggleCollapse(t, id))}
              onRename={(id, title) => setTree((t) => renameNode(t, id, title))}
              onDelete={(id) => {
                setTree((t) => {
                  const snapshot = captureDeletedSubtree(t, id);
                  if (snapshot) setLastDeleted(snapshot);
                  return deleteSubtree(t, id);
                });
              }}
            />
          ) : (
            <MindmapView
              tree={tree}
              visibleNodeIds={filteredNodeIds}
              autoRenameId={autoRenameId}
              onAutoRename={autoRenameNode}
              onSelectNode={(id) => setTree((t) => setActiveNode(t, id))}
              onAddChild={(parentId) => setTree((t) => addChild(t, parentId))}
              onToggleCollapse={(id) => setTree((t) => toggleCollapse(t, id))}
              onRename={(id, title) => setTree((t) => renameNode(t, id, title))}
              onDelete={(id) => {
                setTree((t) => {
                  const snapshot = captureDeletedSubtree(t, id);
                  if (snapshot) setLastDeleted(snapshot);
                  return deleteSubtree(t, id);
                });
              }}
            />
          )}
        </div>
      </aside>

      <main
        style={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
        }}
      >
        <header
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid hsl(var(--border-subtle))",
            display: "flex",
            alignItems: "center",
            gap: 16,
            background: "white",
            boxShadow: "var(--shadow-sm)",
            zIndex: 10,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 18, color: "hsl(var(--text-primary))" }}>
              {activeNode?.title ?? "No active node"}
            </div>
            <div
              style={{
                fontSize: 12,
                color: "hsl(var(--text-tertiary))",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                marginTop: 2,
              }}
            >
              <span style={{ fontWeight: 600, color: "hsl(var(--text-secondary))" }}>Path: </span>
              {pathToRoot.map((n) => n.title || "Untitled").join(" / ")}
            </div>
          </div>

          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as LLMProvider)}
              disabled={isGenerating}
              className="input-fancy"
              style={{
                padding: "6px 12px",
                cursor: isGenerating ? "not-allowed" : "pointer",
                background: isGenerating ? "hsl(var(--bg-secondary))" : "white",
              }}
              title="LLM Provider"
            >
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="gemini">Gemini</option>
            </select>

            {lastDeleted ? (
              <button
                onClick={() => {
                  setTree((t) => restoreDeletedSubtree(t, lastDeleted));
                  setLastDeleted(null);
                }}
                className="btn-secondary"
                style={{ borderRadius: 10, padding: "6px 12px", fontSize: 13 }}
              >
                Undo delete
              </button>
            ) : null}

            {activeNode?.parentId ? (
              <button
                onClick={() => setTree((t) => setActiveNode(t, activeNode.parentId!))}
                className="btn-secondary"
                style={{ borderRadius: 10, padding: "6px 12px", fontSize: 13 }}
              >
                ↑ Back to parent
              </button>
            ) : (
              <span style={{ fontSize: 12, fontWeight: 600, color: "hsl(var(--text-tertiary))" }}>Root Node</span>
            )}
          </div>
        </header>

        <section
          style={{
            flex: 1,
            overflow: "auto",
            padding: 16,
            minHeight: 0,
          }}
        >
          {activeNode?.messages.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {activeNode.messages.map((m) => (
                <div
                  key={m.id}
                  className={`message-bubble ${m.role === "user" ? "message-user" : "message-assistant"}`}
                >
                  <div style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 4,
                    opacity: 0.8
                  }}>
                    {m.role}
                  </div>
                  <ChatMessageContent content={m.content} />
                </div>
              ))}
            </div>
          ) : (
            <div style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "hsl(var(--text-tertiary))",
              flexDirection: "column",
              gap: 12
            }}>
              <span style={{ fontSize: 48 }}>💬</span>
              <div style={{ fontWeight: 500 }}>No messages yet. Start a conversation!</div>
            </div>
          )}
        </section>

        {error ? (
          <div
            style={{
              padding: "0 12px 8px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "#b91c1c",
              fontSize: 13,
            }}
          >
            <span>{error}</span>
            {lastRequest ? (
              <button
                onClick={retryLastRequest}
                style={{
                  borderRadius: 10,
                  border: "1px solid rgba(185,28,28,0.4)",
                  background: "white",
                  padding: "4px 8px",
                  cursor: "pointer",
                }}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}

        <footer
          style={{
            borderTop: "1px solid hsl(var(--border-subtle))",
            padding: "16px 20px",
            display: "flex",
            gap: 12,
            background: "white",
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message..."
            disabled={isGenerating}
            className="input-fancy"
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                sendUserMessage();
              }
            }}
          />
          <button
            onClick={sendUserMessage}
            disabled={isGenerating}
            className="btn-primary"
            style={{
              padding: "10px 24px",
              borderRadius: 12,
              cursor: isGenerating ? "not-allowed" : "pointer",
            }}
          >
            {isGenerating ? "Thinking..." : "Send"}
          </button>
          {isGenerating && (
            <button
              onClick={cancelRequest}
              className="btn-secondary"
              style={{
                padding: "10px 16px",
                borderRadius: 12,
                color: "#dc2626",
                borderColor: "#fecaca",
              }}
            >
              Stop
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}
