export type Role = "system" | "user" | "assistant";

export type Message = {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
};

export type ChatNode = {
  id: string;
  title: string;
  parentId: string | null;
  childrenIds: string[];
  isCollapsed: boolean;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
};

export type ChatTree = {
  rootId: string;
  activeNodeId: string;
  nodes: Record<string, ChatNode>;
};
