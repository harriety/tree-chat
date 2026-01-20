import type { ChatTree, ChatNode, Message, Role } from "../types/chat";

const now = () => Date.now();

// Simple usable id (can swap to uuid later)
export const makeId = () => crypto.randomUUID();

export function createEmptyTree(): ChatTree {
  const rootId = makeId();
  const t = now();

  const root: ChatNode = {
    id: rootId,
    title: "Root",
    parentId: null,
    childrenIds: [],
    isCollapsed: false,
    messages: [],
    createdAt: t,
    updatedAt: t,
  };

  return {
    rootId,
    activeNodeId: rootId,
    nodes: { [rootId]: root },
  };
}

export function addChild(tree: ChatTree, parentId: string): ChatTree {
  const parent = tree.nodes[parentId];
  if (!parent) return tree;

  const childId = makeId();
  const t = now();

  const child: ChatNode = {
    id: childId,
    title: "New thread",
    parentId,
    childrenIds: [],
    isCollapsed: false,
    messages: [],
    createdAt: t,
    updatedAt: t,
  };

  return {
    ...tree,
    activeNodeId: childId,
    nodes: {
      ...tree.nodes,
      [parentId]: {
        ...parent,
        childrenIds: [...parent.childrenIds, childId],
        updatedAt: t,
      },
      [childId]: child,
    },
  };
}

export function toggleCollapse(tree: ChatTree, nodeId: string): ChatTree {
  const node = tree.nodes[nodeId];
  if (!node) return tree;
  return {
    ...tree,
    nodes: {
      ...tree.nodes,
      [nodeId]: { ...node, isCollapsed: !node.isCollapsed, updatedAt: now() },
    },
  };
}

export function setActiveNode(tree: ChatTree, nodeId: string): ChatTree {
  if (!tree.nodes[nodeId]) return tree;
  return { ...tree, activeNodeId: nodeId };
}

export function appendMessage(
  tree: ChatTree,
  nodeId: string,
  role: Role,
  content: string
): ChatTree {
  const node = tree.nodes[nodeId];
  if (!node) return tree;

  const msg: Message = { id: makeId(), role, content, createdAt: now() };
  const t = now();

  return {
    ...tree,
    nodes: {
      ...tree.nodes,
      [nodeId]: {
        ...node,
        messages: [...node.messages, msg],
        updatedAt: t,
        title:
          node.title === "New thread" && role === "user"
            ? content.slice(0, 30)
            : node.title,
      },
    },
  };
}

export function renameNode(tree: ChatTree, nodeId: string, title: string): ChatTree {
  const node = tree.nodes[nodeId];
  if (!node) return tree;

  const t = now();
  return {
    ...tree,
    nodes: {
      ...tree.nodes,
      [nodeId]: { ...node, title: title.trim() || "Untitled", updatedAt: t },
    },
  };
}

export function deleteSubtree(tree: ChatTree, nodeId: string): ChatTree {
  // Do not allow deleting root
  if (nodeId === tree.rootId) return tree;
  const node = tree.nodes[nodeId];
  if (!node) return tree;

  // Collect the whole subtree
  const toDelete = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const curId = stack.pop()!;
    if (toDelete.has(curId)) continue;
    toDelete.add(curId);
    const cur = tree.nodes[curId];
    if (!cur) continue;
    for (const cid of cur.childrenIds) stack.push(cid);
  }

  // Remove from parent's childrenIds
  const parentId = node.parentId;
  const parent = parentId ? tree.nodes[parentId] : undefined;

  const newNodes: typeof tree.nodes = {};
  for (const [id, n] of Object.entries(tree.nodes)) {
    if (!toDelete.has(id)) newNodes[id] = n;
  }

  if (parent && parentId) {
    newNodes[parentId] = {
      ...parent,
      childrenIds: parent.childrenIds.filter((cid) => !toDelete.has(cid)),
      updatedAt: now(),
    };
  }

  // If active node deleted: jump to parent (or root as fallback)
  let nextActive = tree.activeNodeId;
  if (toDelete.has(tree.activeNodeId)) {
    nextActive = parentId ?? tree.rootId;
  }

  return {
    ...tree,
    activeNodeId: nextActive,
    nodes: newNodes,
  };
}
