import * as vscode from 'vscode';
import * as path from 'path';
import { parseArxmlDocument } from './arxmlParser';
import { ArxmlNode } from './arxmlNode';
import { TreeFilterConfig, TreeFilterMode } from './treeProvider';

export interface CrossFileSearchResult {
  file: vscode.Uri;
  matches: ArxmlNode[];
  totalCount: number;
}

export interface WorkspaceSearchResult {
  files: CrossFileSearchResult[];
  totalMatches: number;
  totalFiles: number;
  searchTime: number;
}

interface ParsedFileCache {
  version: number;
  rootNode: ArxmlNode;
  lastModified: number;
}

export class CrossFileSearchProvider implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private fileCache: Map<string, ParsedFileCache> = new Map();
  private isSearching: boolean = false;
  private lastSearchAbortController: AbortController | undefined;

  constructor() {
    // Listen for file system changes to invalidate cache
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(this.onDidChangeTextDocument, this),
      vscode.workspace.onDidDeleteFiles(this.onDidDeleteFiles, this),
      vscode.workspace.onDidRenameFiles(this.onDidRenameFiles, this)
    );
  }

  dispose(): void {
    this.disposables.forEach(disposable => disposable.dispose());
    this.fileCache.clear();
    if (this.lastSearchAbortController) {
      this.lastSearchAbortController.abort();
    }
  }

  /**
   * Find all ARXML files in the workspace
   */
  async findArxmlFiles(): Promise<vscode.Uri[]> {
    const pattern = '**/*.arxml';
    const excludePattern = '**/node_modules/**';
    
    try {
      const files = await vscode.workspace.findFiles(pattern, excludePattern);
      return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    } catch (error) {
      console.error('Failed to find ARXML files:', error);
      vscode.window.showErrorMessage(`Failed to find ARXML files: ${error}`);
      return [];
    }
  }

  /**
   * Search across all ARXML files in the workspace
   */
  async searchWorkspace(
    filter: TreeFilterConfig,
    progressCallback?: (progress: { files: number; matches: number }) => void,
    abortSignal?: AbortSignal
  ): Promise<WorkspaceSearchResult> {
    if (this.isSearching) {
      throw new Error('Search already in progress');
    }

    this.isSearching = true;
    const startTime = Date.now();

    // Cancel any previous search
    if (this.lastSearchAbortController) {
      this.lastSearchAbortController.abort();
    }

    // Create new abort controller for this search
    const combinedAbortController = new AbortController();
    this.lastSearchAbortController = combinedAbortController;

    // Combine external abort signal with our internal one
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => combinedAbortController.abort());
    }

    try {
      const arxmlFiles = await this.findArxmlFiles();
      
      if (combinedAbortController.signal.aborted) {
        throw new Error('Search was cancelled');
      }

      const results: CrossFileSearchResult[] = [];
      let totalMatches = 0;
      let processedFiles = 0;

      // Process files in chunks to avoid blocking the UI
      const chunkSize = 5;
      for (let i = 0; i < arxmlFiles.length; i += chunkSize) {
        if (combinedAbortController.signal.aborted) {
          throw new Error('Search was cancelled');
        }

        const chunk = arxmlFiles.slice(i, i + chunkSize);
        const chunkPromises = chunk.map(file => this.searchFile(file, filter, combinedAbortController.signal));
        
        const chunkResults = await Promise.allSettled(chunkPromises);
        
        for (const result of chunkResults) {
          if (result.status === 'fulfilled' && result.value) {
            results.push(result.value);
            totalMatches += result.value.totalCount;
          }
          processedFiles++;
          
          // Report progress
          if (progressCallback) {
            progressCallback({ files: processedFiles, matches: totalMatches });
          }
        }

        // Yield control to prevent blocking the UI
        await new Promise(resolve => setImmediate(resolve));
      }

      const searchTime = Date.now() - startTime;
      
      return {
        files: results.filter(result => result.totalCount > 0),
        totalMatches,
        totalFiles: results.length,
        searchTime
      };
    } finally {
      this.isSearching = false;
    }
  }

  /**
   * Search within a single ARXML file
   */
  private async searchFile(
    file: vscode.Uri,
    filter: TreeFilterConfig,
    abortSignal?: AbortSignal
  ): Promise<CrossFileSearchResult | null> {
    try {
      if (abortSignal?.aborted) {
        return null;
      }

      const rootNode = await this.getCachedOrParsedFile(file);
      if (!rootNode) {
        return null;
      }

      if (abortSignal?.aborted) {
        return null;
      }

      const matches = this.filterNodes(rootNode, filter);
      
      return {
        file,
        matches,
        totalCount: matches.length
      };
    } catch (error) {
      console.warn(`Failed to search file ${file.fsPath}:`, error);
      return null;
    }
  }

  /**
   * Get parsed file from cache or parse it fresh
   */
  private async getCachedOrParsedFile(file: vscode.Uri): Promise<ArxmlNode | null> {
    const fileKey = file.toString();
    
    try {
      const fileStat = await vscode.workspace.fs.stat(file);
      const cached = this.fileCache.get(fileKey);

      // Check if cache is valid
      if (cached && cached.lastModified >= fileStat.mtime) {
        return cached.rootNode;
      }

      // Parse file fresh
      const content = await vscode.workspace.fs.readFile(file);
      const text = new TextDecoder().decode(content);
      
      if (!text.trim()) {
        return null;
      }

      const document = await vscode.workspace.openTextDocument(file);
      const rootNode = await parseArxmlDocument(
        text,
        file,
        offset => document.positionAt(offset),
        { strict: false }
      );

      if (rootNode) {
        // Cache the parsed result
        this.fileCache.set(fileKey, {
          version: document.version,
          rootNode,
          lastModified: fileStat.mtime
        });
      }

      return rootNode || null;
    } catch (error) {
      console.warn(`Failed to parse file ${file.fsPath}:`, error);
      return null;
    }
  }

  /**
   * Filter nodes based on search criteria
   */
  private filterNodes(rootNode: ArxmlNode, filter: TreeFilterConfig): ArxmlNode[] {
    const matches: ArxmlNode[] = [];
    const stack: ArxmlNode[] = [rootNode];

    while (stack.length > 0) {
      const node = stack.pop()!;
      
      if (this.nodeMatchesFilter(node, filter)) {
        matches.push(node);
      }

      // Continue searching children
      stack.push(...node.children);
    }

    return matches;
  }

  /**
   * Check if a node matches the filter criteria
   */
  private nodeMatchesFilter(node: ArxmlNode, filter: TreeFilterConfig): boolean {
    // Check name filter
    if (filter.name) {
      if (!this.matchesPattern(node.name, filter.name, this.resolveFilterMode(filter, 'name'))) {
        return false;
      }
    }

    // Check ARPATH filter
    if (filter.arpath) {
      if (!this.matchesPattern(node.arpath, filter.arpath, this.resolveFilterMode(filter, 'arpath'))) {
        return false;
      }
    }

    // Check element filter
    if (filter.element) {
      if (!this.matchesPattern(node.element, filter.element, this.resolveFilterMode(filter, 'element'))) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if a name matches the filter based on mode
   */
  private resolveFilterMode(filter: TreeFilterConfig, field: 'name' | 'arpath' | 'element'): TreeFilterMode {
    if (field === 'name' && filter.nameMode) {
      return filter.nameMode;
    }
    if (field === 'arpath' && filter.arpathMode) {
      return filter.arpathMode;
    }
    if (field === 'element' && filter.elementMode) {
      return filter.elementMode;
    }
    return filter.mode;
  }

  private matchesPattern(value: string, pattern: string, mode: TreeFilterMode): boolean {
    switch (mode) {
      case 'contains':
        return value.toLowerCase().includes(pattern.toLowerCase());
      case 'regex':
        try {
          const regex = new RegExp(pattern, 'i');
          return regex.test(value);
        } catch {
          return false;
        }
      case 'glob':
        return this.globMatch(value, pattern);
      default:
        return false;
    }
  }

  /**
   * Simple glob pattern matching
   */
  private globMatch(text: string, pattern: string): boolean {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except * and ?
      .replace(/\*/g, '.*') // * matches any characters
      .replace(/\?/g, '.'); // ? matches single character

    try {
      const regex = new RegExp(`^${regexPattern}$`, 'i');
      return regex.test(text);
    } catch {
      return false;
    }
  }

  /**
   * Get current search status
   */
  isCurrentlySearching(): boolean {
    return this.isSearching;
  }

  /**
   * Cancel current search
   */
  cancelSearch(): void {
    if (this.lastSearchAbortController) {
      this.lastSearchAbortController.abort();
    }
  }

  /**
   * Clear the file cache
   */
  clearCache(): void {
    this.fileCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; files: string[] } {
    return {
      size: this.fileCache.size,
      files: Array.from(this.fileCache.keys())
    };
  }

  // Event handlers for cache invalidation
  private onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
    if (event.document.languageId === 'arxml') {
      const fileKey = event.document.uri.toString();
      this.fileCache.delete(fileKey);
    }
  }

  private onDidDeleteFiles(event: vscode.FileDeleteEvent): void {
    for (const file of event.files) {
      this.fileCache.delete(file.toString());
    }
  }

  private onDidRenameFiles(event: vscode.FileRenameEvent): void {
    for (const { oldUri, newUri } of event.files) {
      const cached = this.fileCache.get(oldUri.toString());
      if (cached) {
        this.fileCache.delete(oldUri.toString());
        this.fileCache.set(newUri.toString(), cached);
      }
    }
  }
}
