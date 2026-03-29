import * as vscode from 'vscode';
import * as path from 'path';
import { parseArxmlDocument } from './arxmlParser';
import { ArxmlNode } from './arxmlNode';
import { createTextPositionResolver } from './textPositionResolver';
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

interface CompiledFilter {
  nameMatcher?: (value: string) => boolean;
  arpathMatcher?: (value: string) => boolean;
  elementMatcher?: (value: string) => boolean;
}

export class CrossFileSearchProvider implements vscode.Disposable {
  private static readonly DEFAULT_LARGE_FILE_THRESHOLD_MB = 50;
  private static readonly MIN_LARGE_FILE_THRESHOLD_MB = 10;
  private static readonly MAX_LARGE_FILE_THRESHOLD_MB = 500;
  private static readonly SMALL_FILE_CHUNK_SIZE = 5;
  private static readonly LARGE_FILE_CHUNK_SIZE = 1;
  private static readonly MAX_CACHE_ENTRIES = 20;
  private static readonly STAT_BATCH_SIZE = 32;


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

    let externalAbortListener: (() => void) | undefined;

    // Combine external abort signal with our internal one
    if (abortSignal) {
      externalAbortListener = () => combinedAbortController.abort();
      abortSignal.addEventListener('abort', externalAbortListener);
      if (abortSignal.aborted) {
        combinedAbortController.abort();
      }
    }

    try {
      const arxmlFiles = await this.findArxmlFiles();
      const fileSizes = await this.getFileSizes(arxmlFiles, combinedAbortController.signal);
      const largeFileThresholdBytes = this.getLargeFileThresholdBytes();
      const compiledFilter = this.compileFilter(filter);
      
      if (combinedAbortController.signal.aborted) {
        throw new Error('Search was cancelled');
      }

      const results: CrossFileSearchResult[] = [];
      let totalMatches = 0;
      let processedFiles = 0;

      const smallFiles = arxmlFiles.filter(file => {
        const size = fileSizes.get(file.toString()) ?? 0;
        return size < largeFileThresholdBytes;
      });
      const largeFiles = arxmlFiles.filter(file => {
        const size = fileSizes.get(file.toString()) ?? 0;
        return size >= largeFileThresholdBytes;
      });

      const processFiles = async (files: vscode.Uri[], chunkSize: number) => {
        for (let i = 0; i < files.length; i += chunkSize) {
          if (combinedAbortController.signal.aborted) {
            throw new Error('Search was cancelled');
          }

          const chunk = files.slice(i, i + chunkSize);
          const chunkPromises = chunk.map(file => this.searchFile(file, compiledFilter, combinedAbortController.signal, largeFileThresholdBytes));
          const chunkResults = await Promise.allSettled(chunkPromises);

          for (const result of chunkResults) {
            if (result.status === 'fulfilled' && result.value) {
              results.push(result.value);
              totalMatches += result.value.totalCount;
            }
            processedFiles++;

            if (progressCallback) {
              progressCallback({ files: processedFiles, matches: totalMatches });
            }
          }

          await new Promise(resolve => setImmediate(resolve));
        }
      };

      await processFiles(smallFiles, CrossFileSearchProvider.SMALL_FILE_CHUNK_SIZE);
      await processFiles(largeFiles, CrossFileSearchProvider.LARGE_FILE_CHUNK_SIZE);

      const searchTime = Date.now() - startTime;
      
      return {
        files: results.filter(result => result.totalCount > 0),
        totalMatches,
        totalFiles: results.length,
        searchTime
      };
    } finally {
      if (abortSignal && externalAbortListener) {
        abortSignal.removeEventListener('abort', externalAbortListener);
      }
      this.isSearching = false;
    }
  }

  /**
   * Search within a single ARXML file
   */
  private async searchFile(
    file: vscode.Uri,
    compiledFilter: CompiledFilter,
    abortSignal?: AbortSignal,
    largeFileThresholdBytes?: number
  ): Promise<CrossFileSearchResult | null> {
    try {
      if (abortSignal?.aborted) {
        return null;
      }

      const rootNode = await this.getCachedOrParsedFile(file, largeFileThresholdBytes ?? this.getLargeFileThresholdBytes(), abortSignal);
      if (!rootNode) {
        return null;
      }

      if (abortSignal?.aborted) {
        return null;
      }

      const matches = this.filterNodes(rootNode, compiledFilter);
      
      return {
        file,
        matches,
        totalCount: matches.length
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'Parsing cancelled') {
        return null;
      }
      console.warn(`Failed to search file ${file.fsPath}:`, error);
      return null;
    }
  }

  /**
   * Get parsed file from cache or parse it fresh
   */
  private async getCachedOrParsedFile(file: vscode.Uri, largeFileThresholdBytes: number, abortSignal?: AbortSignal): Promise<ArxmlNode | null> {
    const fileKey = file.toString();
    
    try {
      const fileStat = await vscode.workspace.fs.stat(file);
      const cached = this.fileCache.get(fileKey);

      // Check if cache is valid
      if (cached && cached.lastModified >= fileStat.mtime) {
        this.touchCacheEntry(fileKey, cached);
        return cached.rootNode;
      }

      const openDocument = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === fileKey);

      let text: string;
      let positionAt: (offset: number) => vscode.Position;
      let version = -1;

      const shouldUseOpenDocument = Boolean(openDocument && fileStat.size < largeFileThresholdBytes);

      if (shouldUseOpenDocument && openDocument) {
        text = openDocument.getText();
        if (!text && fileStat.size > 0) {
          const content = await vscode.workspace.fs.readFile(file);
          text = new TextDecoder().decode(content);
          positionAt = createTextPositionResolver(text);
        } else {
          positionAt = offset => openDocument.positionAt(offset);
          version = openDocument.version;
        }
      } else {
        const content = await vscode.workspace.fs.readFile(file);
        text = new TextDecoder().decode(content);
        positionAt = createTextPositionResolver(text);
      }

      const rootNode = await parseArxmlDocument(
        text,
        file,
        positionAt,
        {
          strict: false,
          abortSignal
        }
      );

      if (rootNode) {
        this.setCacheEntry(fileKey, {
          version,
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
  private filterNodes(rootNode: ArxmlNode, compiledFilter: CompiledFilter): ArxmlNode[] {
    const matches: ArxmlNode[] = [];
    const stack: ArxmlNode[] = [rootNode];

    while (stack.length > 0) {
      const node = stack.pop()!;
      
      if (this.nodeMatchesFilter(node, compiledFilter)) {
        matches.push(node);
      }

      // Continue searching children
      for (const child of node.children) {
        stack.push(child);
      }
    }

    return matches;
  }

  /**
   * Check if a node matches the filter criteria
   */
  private nodeMatchesFilter(node: ArxmlNode, compiledFilter: CompiledFilter): boolean {
    // Check name filter
    if (compiledFilter.nameMatcher && !compiledFilter.nameMatcher(node.name)) {
      return false;
    }

    // Check ARPATH filter
    if (compiledFilter.arpathMatcher && !compiledFilter.arpathMatcher(node.arpath)) {
      return false;
    }

    // Check element filter
    if (compiledFilter.elementMatcher && !compiledFilter.elementMatcher(node.element)) {
      return false;
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

  private compileFilter(filter: TreeFilterConfig): CompiledFilter {
    return {
      nameMatcher: this.compileFieldMatcher(filter, 'name'),
      arpathMatcher: this.compileFieldMatcher(filter, 'arpath'),
      elementMatcher: this.compileFieldMatcher(filter, 'element')
    };
  }

  private compileFieldMatcher(filter: TreeFilterConfig, field: 'name' | 'arpath' | 'element'): ((value: string) => boolean) | undefined {
    const pattern = filter[field];
    if (!pattern) {
      return undefined;
    }

    const mode = this.resolveFilterMode(filter, field);
    if (mode === 'contains') {
      const lowerPattern = pattern.toLowerCase();
      return value => value.toLowerCase().includes(lowerPattern);
    }

    if (mode === 'regex') {
      try {
        const regex = new RegExp(pattern, 'i');
        return value => regex.test(value);
      } catch {
        return () => false;
      }
    }

    if (mode === 'glob') {
      try {
        const regexPattern = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.');
        const regex = new RegExp(`^${regexPattern}$`, 'i');
        return value => regex.test(value);
      } catch {
        return () => false;
      }
    }

    return () => false;
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

  private async getFileSizes(files: vscode.Uri[], abortSignal?: AbortSignal): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    for (let i = 0; i < files.length; i += CrossFileSearchProvider.STAT_BATCH_SIZE) {
      if (abortSignal?.aborted) {
        break;
      }
      const batch = files.slice(i, i + CrossFileSearchProvider.STAT_BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(file => vscode.workspace.fs.stat(file)));
      for (let j = 0; j < batch.length; j++) {
        const file = batch[j];
        const result = results[j];
        if (result.status === 'fulfilled') {
          sizes.set(file.toString(), result.value.size);
        }
      }

      await new Promise(resolve => setImmediate(resolve));
    }
    return sizes;
  }

  private getLargeFileThresholdBytes(): number {
    const config = vscode.workspace.getConfiguration('arxmlTree');
    const thresholdMb = config.get<number>('workspaceSearchLargeFileThresholdMB', CrossFileSearchProvider.DEFAULT_LARGE_FILE_THRESHOLD_MB);
    const clampedMb = Math.max(
      CrossFileSearchProvider.MIN_LARGE_FILE_THRESHOLD_MB,
      Math.min(CrossFileSearchProvider.MAX_LARGE_FILE_THRESHOLD_MB, thresholdMb)
    );
    return clampedMb * 1024 * 1024;
  }

  private touchCacheEntry(fileKey: string, cached: ParsedFileCache): void {
    this.fileCache.delete(fileKey);
    this.fileCache.set(fileKey, cached);
  }

  private setCacheEntry(fileKey: string, entry: ParsedFileCache): void {
    if (this.fileCache.has(fileKey)) {
      this.fileCache.delete(fileKey);
    }
    this.fileCache.set(fileKey, entry);
    while (this.fileCache.size > CrossFileSearchProvider.MAX_CACHE_ENTRIES) {
      const oldest = this.fileCache.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.fileCache.delete(oldest);
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
