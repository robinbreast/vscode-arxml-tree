import * as vscode from 'vscode';
import { ArxmlNode } from './arxmlNode';
import { TreeFilterConfig } from './treeProvider';

export interface LazyArxmlNode extends ArxmlNode {
  childrenLoaded?: boolean;
  hasChildren?: boolean;
  matchesFilter?: boolean;
  virtualChildren?: LazyArxmlNode[];
}

export class OptimizedTreeProvider {
  private static readonly CHUNK_SIZE = 100;
  private static readonly FILTER_DEBOUNCE = 300;
  
  private filterCache = new Map<string, LazyArxmlNode[]>();
  private filterTimer?: NodeJS.Timeout;
  private loadingChunks = new Map<string, Promise<LazyArxmlNode[]>>();

  async getOptimizedChildren(
    parentNode: LazyArxmlNode, 
    filter?: TreeFilterConfig,
    offset = 0,
    limit = OptimizedTreeProvider.CHUNK_SIZE
  ): Promise<LazyArxmlNode[]> {
    const cacheKey = this.buildCacheKey(parentNode, filter, offset, limit);
    
    if (this.filterCache.has(cacheKey)) {
      return this.filterCache.get(cacheKey)!;
    }

    if (this.loadingChunks.has(cacheKey)) {
      return this.loadingChunks.get(cacheKey)!;
    }

    const loadPromise = this.loadChildrenChunk(parentNode, filter, offset, limit);
    this.loadingChunks.set(cacheKey, loadPromise);

    try {
      const result = await loadPromise;
      this.filterCache.set(cacheKey, result);
      return result;
    } finally {
      this.loadingChunks.delete(cacheKey);
    }
  }

  private async loadChildrenChunk(
    parentNode: LazyArxmlNode,
    filter?: TreeFilterConfig,
    offset = 0,
    limit = OptimizedTreeProvider.CHUNK_SIZE
  ): Promise<LazyArxmlNode[]> {
    if (!parentNode.children || parentNode.children.length === 0) {
      return [];
    }

    return new Promise((resolve) => {
      setImmediate(() => {
        const allChildren = parentNode.children;
        let filteredChildren: ArxmlNode[] = allChildren;

        if (filter) {
          filteredChildren = this.applyFilterOptimized(allChildren, filter);
        }

        const chunk = filteredChildren
          .slice(offset, offset + limit)
          .map(child => this.convertToLazyNode(child, filter));

        resolve(chunk);
      });
    });
  }

  private applyFilterOptimized(nodes: ArxmlNode[], filter: TreeFilterConfig): ArxmlNode[] {
    const results: ArxmlNode[] = [];
    const batchSize = 50;

    for (let i = 0; i < nodes.length; i += batchSize) {
      const batch = nodes.slice(i, i + batchSize);
      
      for (const node of batch) {
        if (this.nodeMatchesFilter(node, filter)) {
          results.push(node);
        }
        
        const matchingChildren = this.findMatchingChildren(node, filter);
        if (matchingChildren.length > 0) {
          const nodeWithMatchingChildren = {
            ...node,
            children: matchingChildren
          };
          results.push(nodeWithMatchingChildren);
        }
      }
    }

    return results;
  }

  private findMatchingChildren(node: ArxmlNode, filter: TreeFilterConfig): ArxmlNode[] {
    const matching: ArxmlNode[] = [];
    
    const stack: ArxmlNode[] = [...node.children];
    while (stack.length > 0) {
      const current = stack.pop()!;
      
      if (this.nodeMatchesFilter(current, filter)) {
        matching.push(current);
      }
      
      if (current.children.length > 0) {
        stack.push(...current.children);
      }
    }
    
    return matching;
  }

  private nodeMatchesFilter(node: ArxmlNode, filter: TreeFilterConfig): boolean {
    if (filter.name && !this.matchesPattern(node.name, filter.name, this.resolveFilterMode(filter, 'name'))) {
      return false;
    }
    if (filter.arpath && !this.matchesPattern(node.arpath, filter.arpath, this.resolveFilterMode(filter, 'arpath'))) {
      return false;
    }
    if (filter.element && !this.matchesPattern(node.element, filter.element, this.resolveFilterMode(filter, 'element'))) {
      return false;
    }
    return true;
  }

  private resolveFilterMode(filter: TreeFilterConfig, field: 'name' | 'arpath' | 'element'): 'contains' | 'regex' | 'glob' {
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

  private matchesPattern(value: string, pattern: string, mode: 'contains' | 'regex' | 'glob'): boolean {
    if (!pattern) {
      return true;
    }
    
    if (mode === 'contains') {
      return value.toLowerCase().includes(pattern.toLowerCase());
    }
    
    if (mode === 'regex') {
      try {
        const regex = new RegExp(pattern, 'i');
        return regex.test(value);
      } catch {
        return false;
      }
    }
    
    try {
      const globRegex = this.globToRegex(pattern);
      return globRegex.test(value);
    } catch {
      return false;
    }
  }

  private globToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexText = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    return new RegExp(regexText, 'i');
  }

  private convertToLazyNode(node: ArxmlNode, filter?: TreeFilterConfig): LazyArxmlNode {
    const lazyNode: LazyArxmlNode = {
      ...node,
      childrenLoaded: false,
      hasChildren: node.children && node.children.length > 0,
      matchesFilter: filter ? this.nodeMatchesFilter(node, filter) : true,
      virtualChildren: []
    };

    return lazyNode;
  }

  private buildCacheKey(
    parentNode: LazyArxmlNode, 
    filter?: TreeFilterConfig,
    offset = 0,
    limit = OptimizedTreeProvider.CHUNK_SIZE
  ): string {
    const filterKey = filter ? 
      `${filter.mode}:${filter.nameMode || ''}:${filter.arpathMode || ''}:${filter.elementMode || ''}:${filter.name || ''}:${filter.arpath || ''}:${filter.element || ''}` : 
      'no-filter';
    return `${parentNode.arpath}:${filterKey}:${offset}:${limit}`;
  }

  debouncedApplyFilter(
    callback: () => void,
    delay = OptimizedTreeProvider.FILTER_DEBOUNCE
  ): void {
    if (this.filterTimer) {
      clearTimeout(this.filterTimer);
    }
    
    this.filterTimer = setTimeout(() => {
      callback();
      this.filterTimer = undefined;
    }, delay);
  }

  clearCache(): void {
    this.filterCache.clear();
    this.loadingChunks.clear();
  }

  getCacheStats(): { cacheSize: number; loadingChunks: number } {
    return {
      cacheSize: this.filterCache.size,
      loadingChunks: this.loadingChunks.size
    };
  }

  async preloadChildren(
    parentNode: LazyArxmlNode,
    filter?: TreeFilterConfig,
    maxDepth = 2,
    currentDepth = 0
  ): Promise<void> {
    if (currentDepth >= maxDepth || !parentNode.hasChildren) {
      return;
    }

    const children = await this.getOptimizedChildren(parentNode, filter);
    
    for (const child of children.slice(0, 10)) {
      if (child.hasChildren) {
        void this.preloadChildren(child, filter, maxDepth, currentDepth + 1);
      }
    }
  }

  async getFilteredNodeCount(
    rootNode: LazyArxmlNode,
    filter: TreeFilterConfig
  ): Promise<number> {
    let count = 0;
    const stack: ArxmlNode[] = [rootNode];
    
    while (stack.length > 0) {
      const batch = stack.splice(0, 100);
      
      await new Promise(resolve => setImmediate(resolve));
      
      for (const node of batch) {
        if (this.nodeMatchesFilter(node, filter)) {
          count++;
        }
        if (node.children) {
          stack.push(...node.children);
        }
      }
    }
    
    return count;
  }

  async searchNodes(
    rootNode: LazyArxmlNode,
    searchTerm: string,
    maxResults = 100
  ): Promise<LazyArxmlNode[]> {
    const results: LazyArxmlNode[] = [];
    const stack: ArxmlNode[] = [rootNode];
    const searchLower = searchTerm.toLowerCase();
    
    while (stack.length > 0 && results.length < maxResults) {
      const batch = stack.splice(0, 100);
      
      await new Promise(resolve => setImmediate(resolve));
      
      for (const node of batch) {
        if (node.name.toLowerCase().includes(searchLower) || 
            node.arpath.toLowerCase().includes(searchLower) ||
            node.element.toLowerCase().includes(searchLower)) {
          results.push(this.convertToLazyNode(node));
        }
        
        if (node.children && results.length < maxResults) {
          stack.push(...node.children);
        }
      }
    }
    
    return results;
  }

  createVirtualizedChildren(
    allChildren: ArxmlNode[],
    viewportSize = 50,
    scrollPosition = 0
  ): { visibleChildren: LazyArxmlNode[]; totalCount: number; hasMore: boolean } {
    const startIndex = Math.max(0, scrollPosition - 10);
    const endIndex = Math.min(allChildren.length, scrollPosition + viewportSize + 10);
    
    const visibleChildren = allChildren
      .slice(startIndex, endIndex)
      .map(child => this.convertToLazyNode(child));
    
    return {
      visibleChildren,
      totalCount: allChildren.length,
      hasMore: endIndex < allChildren.length
    };
  }
}
