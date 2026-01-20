import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  type Node,
  type Edge,
  type NodeTypes,
  type NodeProps,
  Position,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";
import type { ChatTree } from "../types/chat";

type Props = {
  tree: ChatTree;
  visibleNodeIds?: Set<string> | null;
  autoRenameId?: string | null;
  onAutoRename?: (nodeId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onAddChild: (parentId: string) => void;
  onToggleCollapse: (nodeId: string) => void;
  onRename: (nodeId: string, title: string) => void;
  onDelete: (nodeId: string) => void;
};

type MindNodeData = {
  id: string;
  title: string;
  isActive: boolean;
  isInPath: boolean;
  isHovered: boolean;
  meta: string;
  hasChildren: boolean;
  isCollapsed: boolean;
  isAutoRenaming: boolean;
  onAutoRename?: (nodeId: string) => void;
  onAddChild: (parentId: string) => void;
  onToggleCollapse: (nodeId: string) => void;
  onRename: (nodeId: string, title: string) => void;
  onDelete: (nodeId: string) => void;
  onHover: (nodeId: string | null) => void;
};

// Custom node component
function MindNode({ data }: NodeProps<MindNodeData>) {
  const {
    id,
    title,
    isActive,
    isInPath,
    isHovered,
    meta,
    hasChildren,
    isCollapsed,
    isAutoRenaming,
    onAutoRename,
    onAddChild,
    onToggleCollapse,
    onRename,
    onDelete,
    onHover,
  } = data;
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);

  useEffect(() => {
    if (!isEditing) setDraftTitle(title);
  }, [title, isEditing]);

  const commitRename = () => {
    const nextTitle = draftTitle.trim();
    if (nextTitle && nextTitle !== title) {
      onRename(id, nextTitle);
    }
    setIsEditing(false);
  };

  const borderColor = isActive ? "#2563eb" : isInPath ? "#60a5fa" : "#e5e7eb";

  return (
    <div
      style={{
        width: 260,
        minHeight: 128,
        borderRadius: 14,
        border: `2px solid ${borderColor}`,
        background: isActive ? "#eff6ff" : "white",
        padding: 12,
        boxShadow: isHovered
          ? "0 10px 22px rgba(37,99,235,0.18)"
          : "0 2px 6px rgba(0,0,0,0.10)",
        cursor: "pointer",
        transition: "box-shadow 0.15s, border-color 0.15s, transform 0.15s",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        position: "relative",
        transform: isHovered ? "translateY(-1px)" : "translateY(0)",
      }}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 9,
          height: 9,
          background: "#93c5fd",
          border: "1px solid #60a5fa",
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 9,
          height: 9,
          background: "#93c5fd",
          border: "1px solid #60a5fa",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: isActive ? "#2563eb" : isInPath ? "#60a5fa" : "#d1d5db",
          }}
        />
        <div style={{ fontSize: 11, color: "#6b7280" }}>{meta}</div>
      </div>

      {isEditing ? (
        <input
          type="text"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setDraftTitle(title);
              setIsEditing(false);
            }
          }}
          onBlur={commitRename}
          autoFocus
          style={{
            width: "100%",
            padding: "6px 8px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.2)",
            fontSize: 14,
            fontWeight: 700,
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div style={{ fontWeight: 800, fontSize: 14 }}>
          {title || "Untitled"}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            background: "#f3f4f6",
            color: "#374151",
          }}
        >
          {hasChildren ? (isCollapsed ? "Collapsed" : "Expanded") : "Leaf"}
        </span>
        {isActive ? (
          <span
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 999,
              background: "#dbeafe",
              color: "#1d4ed8",
            }}
          >
            Active
          </span>
        ) : null}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAddChild(id);
          }}
          style={{
            borderRadius: 8,
            border: "1px solid rgba(0,0,0,0.15)",
            background: "white",
            padding: "2px 6px",
            cursor: "pointer",
            fontSize: 12,
            lineHeight: "16px",
            width: 22,
            height: 22,
          }}
          title="Add child"
        >
          +
        </button>

        {onAutoRename ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAutoRename(id);
            }}
            disabled={isAutoRenaming}
            style={{
              borderRadius: 8,
              border: "1px solid rgba(0,0,0,0.15)",
              background: isAutoRenaming ? "rgba(0,0,0,0.04)" : "white",
              padding: "4px 8px",
              cursor: isAutoRenaming ? "not-allowed" : "pointer",
              fontSize: 12,
            }}
          >
            {isAutoRenaming ? "Auto..." : "Auto Name"}
          </button>
        ) : null}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsEditing(true);
            setDraftTitle(title);
          }}
          style={{
            borderRadius: 8,
            border: "1px solid rgba(0,0,0,0.15)",
            background: "white",
            padding: "2px 6px",
            cursor: "pointer",
            fontSize: 12,
            lineHeight: "16px",
            width: 22,
            height: 22,
          }}
          title="Rename"
        >
          R
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const ok = window.confirm("Delete this node and all its children?");
            if (ok) onDelete(id);
          }}
          style={{
            borderRadius: 8,
            border: "1px solid rgba(0,0,0,0.15)",
            background: "white",
            padding: "2px 6px",
            cursor: "pointer",
            fontSize: 12,
            lineHeight: "16px",
            width: 22,
            height: 22,
          }}
          title="Delete"
        >
          X
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggleCollapse(id);
          }}
          style={{
            borderRadius: 8,
            border: "1px solid rgba(0,0,0,0.15)",
            background: "white",
            padding: "2px 6px",
            cursor: hasChildren ? "pointer" : "not-allowed",
            opacity: hasChildren ? 1 : 0.4,
            fontSize: 12,
            lineHeight: "16px",
            width: 22,
            height: 22,
            marginLeft: "auto",
          }}
          title={isCollapsed ? "Expand" : "Collapse"}
        >
          {isCollapsed ? ">" : "v"}
        </button>
      </div>
    </div>
  );
}

// Get visible node ids (respect collapse state)
function getVisibleNodeIds(tree: ChatTree): Set<string> {
  const visible = new Set<string>();
  const stack = [tree.rootId];

  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (visible.has(nodeId)) continue;

    const node = tree.nodes[nodeId];
    if (!node) continue;

    visible.add(nodeId);

    // If node is not collapsed, add children
    if (!node.isCollapsed) {
      for (const childId of node.childrenIds) {
        stack.push(childId);
      }
    }
  }

  return visible;
}

export function MindmapView({
  tree,
  visibleNodeIds,
  autoRenameId,
  onAutoRename,
  onSelectNode,
  onAddChild,
  onToggleCollapse,
  onRename,
  onDelete,
}: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const nodeTypes: NodeTypes = useMemo(
    () => ({
      mind: MindNode,
    }),
    []
  );

  // Compute nodes and edges
  const { nodes, edges } = useMemo(() => {
    const collapseVisible = getVisibleNodeIds(tree);
    if (visibleNodeIds) {
      for (const id of [...collapseVisible]) {
        if (!visibleNodeIds.has(id)) collapseVisible.delete(id);
      }
    }

    const pathIds = new Set<string>();
    let cur = tree.nodes[tree.activeNodeId];
    while (cur) {
      pathIds.add(cur.id);
      if (!cur.parentId) break;
      cur = tree.nodes[cur.parentId];
    }

    const nodes: Array<Node<MindNodeData>> = [];
    const edges: Edge[] = [];

    // Create nodes
    collapseVisible.forEach((nodeId) => {
      const node = tree.nodes[nodeId];
      if (!node) return;

      nodes.push({
        id: nodeId,
        type: "mind",
        position: { x: 0, y: 0 }, // Updated after layout
        data: {
          id: nodeId,
          title: node.title,
          isActive: tree.activeNodeId === nodeId,
          isInPath: pathIds.has(nodeId),
          isHovered: hoveredId === nodeId,
          meta: `${node.messages.length} msgs · ${node.childrenIds.length} children${node.isCollapsed ? " · Collapsed" : ""}`,
          hasChildren: node.childrenIds.length > 0,
          isCollapsed: node.isCollapsed,
          isAutoRenaming: autoRenameId === nodeId,
          onAutoRename,
          onAddChild,
          onToggleCollapse,
          onRename,
          onDelete,
          onHover: setHoveredId,
        },
        draggable: true,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      });

      // Create edges (if parent is visible)
      if (node.parentId && collapseVisible.has(node.parentId)) {
        const isPathEdge = pathIds.has(node.parentId) && pathIds.has(nodeId);
        const isHoverEdge =
          hoveredId && (node.parentId === hoveredId || nodeId === hoveredId);

        edges.push({
          id: `${node.parentId}-${nodeId}`,
          source: node.parentId,
          target: nodeId,
          type: "smoothstep",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isPathEdge ? "#2563eb" : "#94a3b8",
          },
          style: {
            stroke: isPathEdge ? "#2563eb" : "#94a3b8",
            strokeWidth: isPathEdge ? 2.6 : isHoverEdge ? 2.2 : 1.6,
            opacity: isPathEdge || isHoverEdge ? 1 : 0.7,
          },
        });
      }
    });

    // Auto layout with dagre
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(() => ({}));
    dagreGraph.setGraph({
      rankdir: "LR", // Left to right
      nodesep: 50, // Horizontal node spacing
      ranksep: 90, // Rank spacing
    });

    nodes.forEach((node) => {
      dagreGraph.setNode(node.id, { width: 280, height: 140 });
    });
    edges.forEach((edge) => {
      dagreGraph.setEdge(edge.source, edge.target);
    });

    dagre.layout(dagreGraph);

    const positionedNodes = nodes.map((node) => {
      const dagreNode = dagreGraph.node(node.id);
      return {
        ...node,
        position: {
          x: dagreNode.x - 140,
          y: dagreNode.y - 70,
        },
      };
    });

    return { nodes: positionedNodes, edges };
  }, [
    tree,
    visibleNodeIds,
    autoRenameId,
    onAutoRename,
    onAddChild,
    onToggleCollapse,
    onRename,
    onDelete,
    hoveredId,
  ]);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          style: { stroke: "#94a3b8", strokeWidth: 1.6, opacity: 0.7 },
        }}
      >
        <Background color="#e5e7eb" gap={18} />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}

