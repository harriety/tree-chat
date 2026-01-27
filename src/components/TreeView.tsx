import React, { useState } from "react";
import type { ChatTree, ChatNode } from "../types/chat";

type Props = {
  tree: ChatTree;
  visibleNodeIds?: Set<string> | null;
  autoRenameId?: string | null;
  onAutoRename?: (nodeId: string) => void;
  onSelect: (nodeId: string) => void;
  onAddChild: (parentId: string) => void;
  onToggleCollapse: (nodeId: string) => void;
  onRename: (nodeId: string, title: string) => void;
  onDelete: (nodeId: string) => void;
};

export function TreeView({
  tree,
  visibleNodeIds,
  autoRenameId,
  onAutoRename,
  onSelect,
  onAddChild,
  onToggleCollapse,
  onRename,
  onDelete,
}: Props) {
  const root = tree.nodes[tree.rootId];

  return (
    <div style={{ fontFamily: "var(--font-main)", color: "hsl(var(--text-primary))" }}>
      <div style={{ fontWeight: 700, marginBottom: 16, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.05em", color: "hsl(var(--text-tertiary))" }}>Chat Threads</div>
      <TreeNodeView
        tree={tree}
        node={root}
        depth={0}
        visibleNodeIds={visibleNodeIds}
        autoRenameId={autoRenameId}
        onAutoRename={onAutoRename}
        onSelect={onSelect}
        onAddChild={onAddChild}
        onToggleCollapse={onToggleCollapse}
        onRename={onRename}
        onDelete={onDelete}
      />
    </div>
  );
}

function TreeNodeView({
  tree,
  node,
  depth,
  visibleNodeIds,
  autoRenameId,
  onAutoRename,
  onSelect,
  onAddChild,
  onToggleCollapse,
  onRename,
  onDelete,
}: {
  tree: ChatTree;
  node: ChatNode;
  depth: number;
  visibleNodeIds?: Set<string> | null;
  autoRenameId?: string | null;
  onAutoRename?: (nodeId: string) => void;
  onSelect: (nodeId: string) => void;
  onAddChild: (parentId: string) => void;
  onToggleCollapse: (nodeId: string) => void;
  onRename: (nodeId: string, title: string) => void;
  onDelete: (nodeId: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editTitle, setEditTitle] = useState(node.title);
  const isActive = tree.activeNodeId === node.id;
  const hasChildren = node.childrenIds.length > 0;
  const isVisible = !visibleNodeIds || visibleNodeIds.has(node.id);

  if (!isVisible) return null;

  const handleRename = () => {
    if (editTitle.trim() !== node.title) {
      onRename(node.id, editTitle);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleRename();
    } else if (e.key === "Escape") {
      setEditTitle(node.title);
      setIsEditing(false);
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          marginLeft: depth * 12,
          borderRadius: 12,
          cursor: "pointer",
          background: isActive ? "white" : "transparent",
          boxShadow: isActive ? "var(--shadow-sm)" : "none",
          border: isActive ? "1px solid hsl(var(--brand-primary), 0.2)" : "1px solid transparent",
          transition: "all 0.2s ease",
          marginBottom: 4,
        }}
        className={!isActive ? "tree-node-hover" : ""}
        onClick={() => onSelect(node.id)}
        title={node.id}
      >
        {/* Collapse button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggleCollapse(node.id);
          }}
          className="btn-secondary"
          style={{
            width: 24,
            height: 24,
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
            cursor: hasChildren ? "pointer" : "default",
            opacity: hasChildren ? 1 : 0.3,
            fontSize: 10,
          }}
          aria-label="toggle collapse"
        >
          {hasChildren ? (node.isCollapsed ? "▶" : "▼") : "•"}
        </button>

        {/* Title */}
        <div style={{ flex: 1, fontSize: 14, lineHeight: 1.2 }}>
          {isEditing ? (
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleRename}
              autoFocus
              style={{
                width: "100%",
                padding: "4px 8px",
                borderRadius: 6,
                border: "1px solid rgba(0,0,0,0.15)",
                fontSize: 14,
                fontWeight: 600,
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div
              onDoubleClick={(e) => {
                e.stopPropagation();
                setIsEditing(true);
                setEditTitle(node.title);
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 14, color: isActive ? "hsl(var(--brand-primary))" : "inherit" }}>
                {node.title || "Untitled"}
              </div>
              <div style={{ fontSize: 11, color: "hsl(var(--text-tertiary))", marginTop: 2 }}>
                {node.messages.length} msgs · {node.childrenIds.length} kids
              </div>
            </div>
          )}
        </div>

        {/* Add child */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAddChild(node.id);
          }}
          className="btn-secondary"
          style={{
            borderRadius: 8,
            padding: "4px 8px",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          + Child
        </button>

        {onAutoRename ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAutoRename(node.id);
            }}
            disabled={autoRenameId === node.id}
            style={{
              borderRadius: 8,
              border: "1px solid rgba(0,0,0,0.15)",
              background: autoRenameId === node.id ? "rgba(0,0,0,0.04)" : "white",
              padding: "4px 8px",
              cursor: autoRenameId === node.id ? "not-allowed" : "pointer",
            }}
          >
            {autoRenameId === node.id ? "Auto..." : "Auto Name"}
          </button>
        ) : null}

        {isDeleting ? (
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(node.id);
                setIsDeleting(false);
              }}
              className="btn-primary"
              style={{
                borderRadius: 8,
                padding: "4px 8px",
                fontSize: 10,
                background: "#dc2626",
              }}
            >
              Sure?
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsDeleting(false);
              }}
              className="btn-secondary"
              style={{
                borderRadius: 8,
                padding: "4px 8px",
                fontSize: 10,
              }}
            >
              Abort
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsDeleting(true);
            }}
            className="btn-secondary"
            style={{
              borderRadius: 8,
              padding: "4px 10px",
              fontSize: 11,
              color: "#dc2626",
              borderColor: "#fecaca",
              fontWeight: 600,
            }}
          >
            Delete
          </button>
        )}
      </div>

      {!node.isCollapsed &&
        node.childrenIds.map((cid) => {
          const child = tree.nodes[cid];
          if (!child) return null;
          return (
            <TreeNodeView
              key={cid}
              tree={tree}
              node={child}
              depth={depth + 1}
              visibleNodeIds={visibleNodeIds}
              autoRenameId={autoRenameId}
              onAutoRename={onAutoRename}
              onSelect={onSelect}
              onAddChild={onAddChild}
              onToggleCollapse={onToggleCollapse}
              onRename={onRename}
              onDelete={onDelete}
            />
          );
        })}
    </div>
  );
}

