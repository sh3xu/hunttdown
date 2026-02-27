import {
  Project,
  Node,
  SyntaxKind,
  type SourceFile,
  type FunctionDeclaration,
  type ArrowFunction,
  type FunctionExpression,
  type MethodDeclaration,
} from "ts-morph";
import path from "path";
import fs from "fs/promises";
import type { ProjectGraph, ProjectNode, ProjectEdge } from "./types";

type SendFn = (payload: object) => void;

// A callable unit — function, arrow fn, method
type FunctionLike =
  | FunctionDeclaration
  | ArrowFunction
  | FunctionExpression
  | MethodDeclaration;

export class AnalyzerEngine {
  private project: Project;
  private rootPath: string;
  private send: SendFn;

  // Maps from fully-qualified function name → node ID
  private fnRegistry = new Map<string, string>();

  constructor(rootPath: string, send: SendFn = () => {}) {
    this.rootPath = rootPath;
    this.send = send;
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        noEmit: true,
        skipLibCheck: true,
      },
    });
  }

  public async analyze(): Promise<ProjectGraph> {
    const nodesMap = new Map<string, ProjectNode>();
    const edgesMap = new Map<string, ProjectEdge & { callCount: number }>();

    const addEdge = (
      from: string,
      to: string,
      relation: ProjectEdge["relation"],
    ) => {
      const key = `${from}→${to}→${relation}`;
      if (edgesMap.has(key)) {
        const e = edgesMap.get(key)!;
        if (relation === "calls") e.callCount = (e.callCount || 1) + 1;
      } else {
        edgesMap.set(key, { from, to, relation, callCount: 1 });
      }
    };

    const normalizedRoot = this.rootPath.replace(/\\/g, "/");

    this.send({
      type: "progress",
      pct: 38,
      message: "Scanning for TypeScript and JavaScript files...",
    });

    this.project.addSourceFilesAtPaths([
      `${normalizedRoot}/**/*.ts`,
      `${normalizedRoot}/**/*.tsx`,
      `${normalizedRoot}/**/*.js`,
      `${normalizedRoot}/**/*.jsx`,
    ]);

    // Non-code file suffixes to completely ignore (images, media, fonts, etc.)
    const BINARY_EXTENSIONS = new Set([
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".avif",
      ".mp4", ".webm", ".mov", ".avi", ".mkv", ".mp3", ".wav", ".ogg",
      ".woff", ".woff2", ".ttf", ".eot", ".otf",
      ".pdf", ".zip", ".tar", ".gz", ".7z",
      ".lock", ".bin", ".exe", ".dll", ".so",
      ".map", ".min.js", ".min.css",
    ]);

    // Ignore typical bundled/generated directories
    const ignoredPaths = [
      "/node_modules/",
      "/dist/",
      "/build/",
      "/.next/",
      "/out/",
      "/coverage/",
      "/vendor/",
      "/.git/"
    ];

    for (const sf of this.project.getSourceFiles()) {
      const p = sf.getFilePath().replace(/\\/g, "/");
      const ext = path.extname(p).toLowerCase();
      if (
        ignoredPaths.some((ignored) => p.includes(ignored)) ||
        BINARY_EXTENSIONS.has(ext) ||
        p.endsWith(".min.js") || p.endsWith(".min.css")
      ) {
        this.project.removeSourceFile(sf);
      }
    }

    const sourceFiles = this.project.getSourceFiles();
    this.send({
      type: "progress",
      pct: 42,
      message: `Found ${sourceFiles.length} files. Building symbol registry...`,
    });

    // === PASS 1: Build all file/folder/function/class nodes ===
    const folderPaths = new Set<string>();
    let processed = 0;

    for (const sourceFile of sourceFiles) {
      processed++;
      const filePath = sourceFile.getFilePath();
      const relativePath = path
        .relative(this.rootPath, filePath)
        .replace(/\\/g, "/");

      if (
        relativePath.startsWith("..") ||
        relativePath.includes("node_modules")
      )
        continue;

      const pct = 42 + Math.floor((processed / sourceFiles.length) * 18); // 42→60
      if (processed % 5 === 0 || processed === sourceFiles.length) {
        this.send({
          type: "progress",
          pct,
          message: `Pass 1 (${processed}/${sourceFiles.length}): ${path.basename(filePath)}`,
        });
      }

      this._addFolderNodes(relativePath, nodesMap, folderPaths, addEdge);

      const fileNodeId = `file:${relativePath}`;
      const parentDir = path.dirname(relativePath).replace(/\\/g, "/");

      nodesMap.set(fileNodeId, {
        id: fileNodeId,
        name: path.basename(filePath),
        type: "file",
        path: relativePath,
        parentId: parentDir === "." ? undefined : `folder:${parentDir}`,
        // Keep file content smaller — functions/classes carry their own content
        content: sourceFile.getFullText().slice(0, 8000),
      });

      if (parentDir !== ".")
        addEdge(`folder:${parentDir}`, fileNodeId, "contains");

      // Import edges
      for (const imp of sourceFile.getImportDeclarations()) {
        const resolved = imp.getModuleSpecifierSourceFile();
        if (resolved) {
          const targetPath = path
            .relative(this.rootPath, resolved.getFilePath())
            .replace(/\\/g, "/");
          if (!targetPath.includes("node_modules")) {
            addEdge(fileNodeId, `file:${targetPath}`, "imports");
          }
        }
      }

      // Functions (named + exported)
      sourceFile.getFunctions().forEach((fn, idx) => {
        this._registerFunction(
          fn,
          idx,
          fileNodeId,
          relativePath,
          nodesMap,
          addEdge,
        );
      });

      // Arrow / function expressions assigned to variables
      sourceFile.getVariableDeclarations().forEach((v) => {
        const init = v.getInitializer();
        if (
          init &&
          (init.getKind() === SyntaxKind.ArrowFunction ||
            init.getKind() === SyntaxKind.FunctionExpression)
        ) {
          const name = v.getName();
          const fnId = `${fileNodeId}:fn:${name}`;
          if (!nodesMap.has(fnId)) {
            this.fnRegistry.set(name, fnId);
            nodesMap.set(fnId, {
              id: fnId,
              name,
              type: "function",
              path: relativePath,
              line: v.getStartLineNumber(),
              parentId: fileNodeId,
              content: init.getText().slice(0, 3000),
              signature: `const ${name} = ${init.getText().split("\n")[0]}`,
            });
            addEdge(fileNodeId, fnId, "contains");
          }
        }
      });

      // Classes + methods
      sourceFile.getClasses().forEach((cls, idx) => {
        const name = cls.getName() || `AnonymousClass_${idx}`;
        const clsId = `${fileNodeId}:cls:${name}`;
        this.fnRegistry.set(name, clsId);
        nodesMap.set(clsId, {
          id: clsId,
          name,
          type: "class",
          path: relativePath,
          line: cls.getStartLineNumber(),
          parentId: fileNodeId,
          content: cls.getText().slice(0, 3000),
          docComment: cls
            .getJsDocs()
            .map((d) => d.getCommentText())
            .filter(Boolean)
            .join("\n"),
        });
        addEdge(fileNodeId, clsId, "contains");

        cls.getMethods().forEach((method) => {
          const methodName = method.getName();
          const methodId = `${clsId}:method:${methodName}`;
          this.fnRegistry.set(`${name}.${methodName}`, methodId);
          nodesMap.set(methodId, {
            id: methodId,
            name: methodName,
            type: "function",
            path: relativePath,
            line: method.getStartLineNumber(),
            parentId: clsId,
            content: method.getText().slice(0, 3000),
            signature: method.getText().split("{")[0].trim(),
            docComment: method
              .getJsDocs()
              .map((d) => d.getCommentText())
              .filter(Boolean)
              .join("\n"),
          });
          addEdge(clsId, methodId, "contains");
        });
      });
    }

    this.send({
      type: "progress",
      pct: 61,
      message: "Symbol registry built. Analyzing call graph...",
    });

    // === PASS 2: Trace function call edges ===
    processed = 0;
    for (const sourceFile of sourceFiles) {
      processed++;
      const filePath = sourceFile.getFilePath();
      const relativePath = path
        .relative(this.rootPath, filePath)
        .replace(/\\/g, "/");
      if (
        relativePath.startsWith("..") ||
        relativePath.includes("node_modules")
      )
        continue;

      const pct = 61 + Math.floor((processed / sourceFiles.length) * 12); // 61→73
      if (processed % 10 === 0 || processed === sourceFiles.length) {
        this.send({
          type: "progress",
          pct,
          message: `Call graph (${processed}/${sourceFiles.length}): ${path.basename(filePath)}`,
        });
      }

      this._traceCallEdges(sourceFile, relativePath, nodesMap, addEdge);
    }

    this.send({
      type: "progress",
      pct: 74,
      message: "Call graph complete. Preparing results...",
    });

    const nodes = Array.from(nodesMap.values());
    const nodeIds = new Set(nodes.map((n) => n.id));
    const validEdges = Array.from(edgesMap.values()).filter(
      (e) => nodeIds.has(e.from) && nodeIds.has(e.to),
    );

    return { nodes, edges: validEdges, rootPath: this.rootPath };
  }

  private _addFolderNodes(
    relativePath: string,
    nodesMap: Map<string, ProjectNode>,
    folderPaths: Set<string>,
    addEdge: (f: string, t: string, r: ProjectEdge["relation"]) => void,
  ) {
    let currentDir = path.dirname(relativePath).replace(/\\/g, "/");
    while (currentDir !== "." && currentDir !== "" && currentDir !== "/") {
      if (!folderPaths.has(currentDir)) {
        folderPaths.add(currentDir);
        nodesMap.set(`folder:${currentDir}`, {
          id: `folder:${currentDir}`,
          name: path.basename(currentDir),
          type: "folder",
          path: currentDir,
        });
        const parentDir = path.dirname(currentDir).replace(/\\/g, "/");
        if (parentDir !== "." && parentDir !== "") {
          addEdge(`folder:${parentDir}`, `folder:${currentDir}`, "contains");
        }
      }
      currentDir = path.dirname(currentDir).replace(/\\/g, "/");
    }
  }

  private _registerFunction(
    fn: FunctionDeclaration,
    idx: number,
    fileNodeId: string,
    relativePath: string,
    nodesMap: Map<string, ProjectNode>,
    addEdge: (f: string, t: string, r: ProjectEdge["relation"]) => void,
  ) {
    const name = fn.getName() || `anonymous_${idx}`;
    const fnId = `${fileNodeId}:fn:${name}`;
    this.fnRegistry.set(name, fnId);
    nodesMap.set(fnId, {
      id: fnId,
      name,
      type: "function",
      path: relativePath,
      line: fn.getStartLineNumber(),
      parentId: fileNodeId,
      content: fn.getText().slice(0, 3000),
      signature: fn.getText().split("{")[0].trim(),
      docComment: fn
        .getJsDocs()
        .map((d) => d.getCommentText())
        .filter(Boolean)
        .join("\n"),
    });
    addEdge(fileNodeId, fnId, "contains");
  }

  private _traceCallEdges(
    sourceFile: SourceFile,
    relativePath: string,
    nodesMap: Map<string, ProjectNode>,
    addEdge: (f: string, t: string, r: ProjectEdge["relation"]) => void,
  ) {
    const fileNodeId = `file:${relativePath}`;

    // Walk all call expressions in the file
    sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .forEach((callExpr) => {
        const callerFnId = this._findContainingFunctionId(
          callExpr,
          fileNodeId,
          relativePath,
          nodesMap,
        );
        if (!callerFnId) return;

        // Try to resolve the called symbol
        const expr = callExpr.getExpression();
        let calledName: string | undefined;

        if (Node.isIdentifier(expr)) {
          calledName = expr.getText();
        } else if (Node.isPropertyAccessExpression(expr)) {
          const obj = expr.getExpression().getText();
          const prop = expr.getName();
          // Check both Class.method and just method forms
          calledName = this.fnRegistry.has(`${obj}.${prop}`)
            ? `${obj}.${prop}`
            : prop;
        }

        if (!calledName) return;

        // Try to resolve to a declaration
        const targetId = this.fnRegistry.get(calledName);
        if (targetId && targetId !== callerFnId && nodesMap.has(targetId)) {
          addEdge(callerFnId, targetId, "calls");
          return;
        }

        // Fallback: use ts-morph symbol resolution
        try {
          const symbol = expr.getSymbol();
          if (symbol) {
            const decls = symbol.getDeclarations();
            for (const decl of decls) {
              const sf = decl.getSourceFile();
              const targetRel = path
                .relative(this.rootPath, sf.getFilePath())
                .replace(/\\/g, "/");
              if (targetRel.includes("node_modules")) continue;

              const targetFileId = `file:${targetRel}`;
              const declName = symbol.getName();
              const candidates = [
                `${targetFileId}:fn:${declName}`,
                `${targetFileId}:cls:${declName}`,
              ];
              for (const c of candidates) {
                if (nodesMap.has(c) && c !== callerFnId) {
                  addEdge(callerFnId, c, "calls");
                  break;
                }
              }
            }
          }
        } catch {}
      });
  }

  private _findContainingFunctionId(
    node: Node,
    fileNodeId: string,
    relativePath: string,
    nodesMap: Map<string, ProjectNode>,
  ): string | null {
    let current: Node | undefined = node;

    while (current) {
      const kind = current.getKind();

      if (kind === SyntaxKind.FunctionDeclaration) {
        const fn = current as FunctionDeclaration;
        const name = fn.getName();
        if (name) {
          const id = `${fileNodeId}:fn:${name}`;
          if (nodesMap.has(id)) return id;
        }
      }

      if (kind === SyntaxKind.MethodDeclaration) {
        const method = current as MethodDeclaration;
        const cls = method.getParent();
        if (Node.isClassDeclaration(cls)) {
          const clsName = cls.getName();
          const methodId = `${fileNodeId}:cls:${clsName}:method:${method.getName()}`;
          if (nodesMap.has(methodId)) return methodId;
        }
      }

      if (kind === SyntaxKind.VariableDeclaration) {
        const v = current as any;
        const name = v.getName?.();
        if (name) {
          const id = `${fileNodeId}:fn:${name}`;
          if (nodesMap.has(id)) return id;
        }
      }

      current = current.getParent();
    }

    return null; // Top-level or unresolvable
  }
}
