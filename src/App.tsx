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

const STORAGE_KEY_PREFIX = "tree-chat:tree:";
const TREE_LIST_KEY = "tree-chat:tree-list";
const ACTIVE_TREE_ID_KEY = "tree-chat:active-tree-id";
const SIDEBAR_WIDTH_KEY = "tree-chat:sidebar-width";
const OLD_STORAGE_KEY = "tree-chat:tree"; // For migration

const PROVIDER_KEY = "tree-chat:provider";
const BACKUP_KEY = "tree-chat:backups";
const MAX_BACKUPS = 5;
const BACKUP_INTERVAL_MS = 2 * 60 * 1000;

type TreeMetadata = {
  id: string;
  title: string;
  updatedAt: number;
};

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

function loadTreeList(): TreeMetadata[] {
  try {
    const raw = localStorage.getItem(TREE_LIST_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as TreeMetadata[];
  } catch {
    return [];
  }
}

function saveTreeList(list: TreeMetadata[]) {
  localStorage.setItem(TREE_LIST_KEY, JSON.stringify(list));
}

function loadTree(id: string): ChatTree | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + id);
    if (!raw) return null;
    return JSON.parse(raw) as ChatTree;
  } catch {
    return null;
  }
}

function saveTree(id: string, tree: ChatTree) {
  localStorage.setItem(STORAGE_KEY_PREFIX + id, JSON.stringify(tree));
}

function migrateOldData(): { treeList: TreeMetadata[]; activeId: string | null } {
  const oldRaw = localStorage.getItem(OLD_STORAGE_KEY);
  if (oldRaw) {
    try {
      const oldTree = JSON.parse(oldRaw) as ChatTree;
      const id = makeId();
      const metadata: TreeMetadata = {
        id,
        title: oldTree.nodes[oldTree.rootId]?.title || "Migrated Tree",
        updatedAt: Date.now(),
      };
      saveTree(id, oldTree);
      saveTreeList([metadata]);
      localStorage.setItem(ACTIVE_TREE_ID_KEY, id);
      localStorage.removeItem(OLD_STORAGE_KEY);
      return { treeList: [metadata], activeId: id };
    } catch {
      localStorage.removeItem(OLD_STORAGE_KEY);
    }
  }
  return { treeList: [], activeId: null };
}

export default function App() {
  const [activeTreeId, setActiveTreeId] = useState<string>(() => {
    const migrated = migrateOldData();
    if (migrated.activeId) return migrated.activeId;
    const saved = localStorage.getItem(ACTIVE_TREE_ID_KEY);
    if (saved && loadTree(saved)) return saved;
    const list = loadTreeList();
    if (list.length > 0) return list[0].id;
    return "";
  });

  const [treeList, setTreeList] = useState<TreeMetadata[]>(() => {
    const list = loadTreeList();
    return list;
  });

  const [tree, setTree] = useState<ChatTree>(() => {
    if (activeTreeId) {
      const loaded = loadTree(activeTreeId);
      if (loaded) return loaded;
    }
    const newTree = createEmptyTree();
    const newId = makeId();
    const metadata: TreeMetadata = {
      id: newId,
      title: "New Tree",
      updatedAt: Date.now(),
    };
    saveTree(newId, newTree);
    const newList = [metadata];
    saveTreeList(newList);
    setTreeList(newList);
    setActiveTreeId(newId);
    localStorage.setItem(ACTIVE_TREE_ID_KEY, newId);
    return newTree;
  });

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

  const [deletingTreeId, setDeletingTreeId] = useState<string | null>(null);
  const [editingTreeId, setEditingTreeId] = useState<string | null>(null);
  const [editingTreeTitle, setEditingTreeTitle] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : 320;
  });
  const [isResizing, setIsResizing] = useState(false);
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
      if (!activeTreeId) return;
      try {
        saveTree(activeTreeId, tree);
        const rootNode = tree.nodes[tree.rootId];
        // Only auto-update title if it's not currently being manually edited
        if (editingTreeId !== activeTreeId) {
          const newTitle = rootNode?.title && rootNode.title !== "Root"
            ? rootNode.title
            : treeList.find(m => m.id === activeTreeId)?.title || "New Tree";

          const newList = treeList.map(m =>
            m.id === activeTreeId
              ? { ...m, title: newTitle, updatedAt: Date.now() }
              : m
          );
          if (JSON.stringify(newList) !== JSON.stringify(treeList)) {
            saveTreeList(newList);
            setTreeList(newList);
          }
        }
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
  }, [tree, activeTreeId, treeList, editingTreeId]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isResizing) return;

    const handlePointerMove = (e: PointerEvent) => {
      const newWidth = Math.max(260, Math.min(800, e.clientX));
      setSidebarWidth(newWidth);
    };

    const handlePointerUp = () => {
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isResizing]);

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

  const handleRenameTree = (id: string, newTitle: string) => {
    if (editingTreeId === null) return;
    const newList = treeList.map(m => m.id === id ? { ...m, title: newTitle || "Untitled", updatedAt: Date.now() } : m);
    setTreeList(newList);
    saveTreeList(newList);

    // If we're renaming the active tree, also update the root node title if it's generic
    if (id === activeTreeId) {
      const rootNode = tree.nodes[tree.rootId];
      if (rootNode && (rootNode.title === "Root" || rootNode.title === "New thread" || !rootNode.title)) {
        setTree(t => renameNode(t, tree.rootId, newTitle));
      }
    }

    setEditingTreeId(null);
  };

  const handleNewTree = () => {
    const newId = makeId();
    const newTree = createEmptyTree();
    const metadata: TreeMetadata = {
      id: newId,
      title: "New Tree",
      updatedAt: Date.now(),
    };
    const newList = [metadata, ...treeList];
    saveTreeList(newList);
    setTreeList(newList);
    saveTree(newId, newTree);
    setTree(newTree);
    setActiveTreeId(newId);
    localStorage.setItem(ACTIVE_TREE_ID_KEY, newId);
  };

  const handleSwitchTree = (id: string) => {
    if (id === activeTreeId) return;
    const loaded = loadTree(id);
    if (loaded) {
      setTree(loaded);
      setActiveTreeId(id);
      localStorage.setItem(ACTIVE_TREE_ID_KEY, id);
    }
  };

  const handleDeleteTree = (id: string) => {
    if (treeList.length <= 1) {
      window.alert("You must have at least one workspace.");
      setDeletingTreeId(null);
      return;
    }

    const newList = treeList.filter(m => m.id !== id);
    saveTreeList(newList);
    setTreeList(newList);
    localStorage.removeItem(STORAGE_KEY_PREFIX + id);

    if (id === activeTreeId) {
      const nextId = newList[0].id;
      const loaded = loadTree(nextId);
      if (loaded) {
        setTree(loaded);
        setActiveTreeId(nextId);
        localStorage.setItem(ACTIVE_TREE_ID_KEY, nextId);
      }
    }
    setDeletingTreeId(null);
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex", // Changed from grid to flex for better resizable control
        overflow: "hidden",
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
          width: sidebarWidth,
          minWidth: 260,
          maxWidth: 800,
          flexShrink: 0,
        }}
      >
        <div className="sidebar-section" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.05em", color: "hsl(var(--text-tertiary))" }}>Workspaces</h3>
            <button
              onClick={handleNewTree}
              className="btn-primary"
              style={{ padding: "4px 8px", borderRadius: 8, fontSize: 11 }}
            >
              + New
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {treeList.map(t => (
              <div
                key={t.id}
                onClick={() => handleSwitchTree(t.id)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  fontSize: 13,
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: activeTreeId === t.id ? "white" : "transparent",
                  boxShadow: activeTreeId === t.id ? "var(--shadow-sm)" : "none",
                  border: activeTreeId === t.id ? "1px solid hsl(var(--brand-primary), 0.2)" : "1px solid transparent",
                  transition: "all 0.2s ease",
                }}
              >
                <div style={{
                  fontWeight: activeTreeId === t.id ? 600 : 400,
                  color: activeTreeId === t.id ? "hsl(var(--brand-primary))" : "inherit",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1
                }}>
                  {editingTreeId === t.id ? (
                    <input
                      autoFocus
                      value={editingTreeTitle}
                      onChange={(e) => setEditingTreeTitle(e.target.value)}
                      onFocus={(e) => e.target.select()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameTree(t.id, editingTreeTitle);
                        if (e.key === "Escape") setEditingTreeId(null);
                      }}
                      onBlur={() => handleRenameTree(t.id, editingTreeTitle)}
                      onClick={(e) => e.stopPropagation()}
                      className="input-fancy"
                      style={{ width: "100%", padding: "4px 8px", fontSize: 13 }}
                    />
                  ) : (
                    <div
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingTreeId(t.id);
                        setEditingTreeTitle(t.title);
                      }}
                      title="Double click to rename"
                    >
                      {t.title}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {deletingTreeId === t.id ? (
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteTree(t.id);
                        }}
                        style={{
                          background: "#dc2626",
                          border: "none",
                          color: "white",
                          borderRadius: 6,
                          padding: "2px 6px",
                          fontSize: 10,
                          fontWeight: 700,
                        }}
                      >
                        Confirm
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeletingTreeId(null);
                        }}
                        style={{
                          background: "#e5e7eb",
                          border: "none",
                          color: "#374151",
                          borderRadius: 6,
                          padding: "2px 6px",
                          fontSize: 10,
                          fontWeight: 700,
                        }}
                      >
                        Esc
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeletingTreeId(t.id);
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "hsl(var(--text-tertiary))",
                        cursor: "pointer",
                        fontSize: 16,
                        padding: "0 4px",
                        opacity: 0.6
                      }}
                      onMouseOver={(e) => e.currentTarget.style.opacity = "1"}
                      onMouseOut={(e) => e.currentTarget.style.opacity = "0.6"}
                      title="Delete workspace"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

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
              const ok = window.confirm("Reset THIS tree and clear its data?");
              if (!ok) return;
              const newTree = createEmptyTree();
              setTree(newTree);
              saveTree(activeTreeId, newTree);
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

      <div
        onPointerDown={(e) => {
          e.preventDefault();
          setIsResizing(true);
        }}
        style={{
          width: 5,
          cursor: "col-resize",
          background: isResizing ? "hsl(var(--brand-primary))" : "transparent",
          borderLeft: "1px solid hsl(var(--border-subtle))",
          transition: "background 0.2s",
          zIndex: 50,
          position: "relative",
          marginLeft: -2,
          marginRight: -2,
        }}
        className="resize-splitter"
        onMouseEnter={(e) => {
          if (!isResizing) e.currentTarget.style.background = "hsla(var(--brand-primary), 0.2)";
        }}
        onMouseLeave={(e) => {
          if (!isResizing) e.currentTarget.style.background = "transparent";
        }}
      />

      <main
        style={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          flex: 1,
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
