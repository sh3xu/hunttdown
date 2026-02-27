export type NodeType = "folder" | "file" | "function" | "class" | "component";

export interface ProjectNode {
  id: string;
  name: string;
  type: NodeType;
  path: string;
  line?: number;
  parentId?: string;
  content?: string; // source code of function/class body
  signature?: string; // function signature string
  docComment?: string; // JSDoc comment if present
}

export type RelationType =
  | "imports"
  | "calls"
  | "extends"
  | "renders"
  | "contains";

export interface ProjectEdge {
  from: string;
  to: string;
  relation: RelationType;
  // For call edges: how many times is this called?
  callCount?: number;
}

export interface ProjectGraph {
  nodes: ProjectNode[];
  edges: ProjectEdge[];
  rootPath: string;
}
