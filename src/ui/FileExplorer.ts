import * as monaco from 'monaco-editor';
import { IErrorMessage } from '../verilator/ErrorParser';
import { readStorage, readStoredNumber, writeStorage } from './storage';

type MarkerData = monaco.editor.IMarkerData;

export interface FileExplorerOptions {
  container: HTMLElement;
  editorModel: monaco.editor.ITextModel;
  getSources: () => Record<string, string>;
  /** Files read via $readmem, keyed by the path as written (relative to src/) */
  getDataFiles: () => Record<string, string> | undefined;
  getEditorValue: () => string;
  setEditorValue: (value: string) => void;
}

const VALID_EXTENSIONS = ['.v', '.sv', '.vh', '.svh'];
const MIN_WIDTH = 150;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 210;
const WIDTH_KEY = 'vga-playground.explorerWidth';
const COLLAPSED_KEY = 'vga-playground.explorerCollapsed';

const ICON_CHEVRON_DOWN = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>`;
const ICON_CHEVRON_RIGHT = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>`;
const ICON_NEW_FILE = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>`;
const ICON_COLLAPSE = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 4L6 8l4 4"/></svg>`;
const ICON_EXPAND = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>`;
const ICON_FILE = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 2H4.5a1 1 0 00-1 1v10a1 1 0 001 1h7a1 1 0 001-1V5.3L9.2 2z"/><path d="M9 2.2v3.3h3.4"/></svg>`;

export function isValidFileName(name: string) {
  return VALID_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.includes('/');
}

export class FileExplorer {
  currentFileName = 'project.v';
  /** Set while a data file (rather than a source file) is open in the editor */
  currentDataFile: string | null = null;
  private readonly markersPerFile: Record<string, MarkerData[]> = {};

  private readonly container: HTMLElement;
  private readonly editorModel: monaco.editor.ITextModel;
  private readonly getSources: () => Record<string, string>;
  private readonly getDataFiles: () => Record<string, string> | undefined;
  private readonly getEditorValue: () => string;
  private readonly setEditorValue: (value: string) => void;

  private readonly fileList: HTMLDivElement;
  private readonly contextMenu: HTMLDivElement;
  private readonly collapseButton: HTMLButtonElement;

  private readonly collapsedFolders = new Set<string>();
  private collapsed = false;
  private width = DEFAULT_WIDTH;

  constructor(opts: FileExplorerOptions) {
    this.container = opts.container;
    this.editorModel = opts.editorModel;
    this.getSources = opts.getSources;
    this.getDataFiles = opts.getDataFiles;
    this.getEditorValue = opts.getEditorValue;
    this.setEditorValue = opts.setEditorValue;

    this.container.classList.add('file-explorer');

    const header = document.createElement('div');
    header.className = 'explorer-header';

    const title = document.createElement('span');
    title.className = 'explorer-title';
    title.textContent = 'Explorer';
    header.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'explorer-actions';

    const newFileButton = document.createElement('button');
    newFileButton.className = 'explorer-action';
    newFileButton.innerHTML = ICON_NEW_FILE;
    newFileButton.title = 'New file';
    newFileButton.setAttribute('aria-label', 'New file');
    newFileButton.addEventListener('click', () => this.createFile());
    actions.appendChild(newFileButton);

    this.collapseButton = document.createElement('button');
    this.collapseButton.className = 'explorer-action';
    this.collapseButton.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    actions.appendChild(this.collapseButton);

    header.appendChild(actions);
    this.container.appendChild(header);

    const tree = document.createElement('div');
    tree.className = 'explorer-tree';
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', 'Project files');

    this.fileList = document.createElement('div');
    this.fileList.className = 'explorer-files';
    this.fileList.addEventListener('keydown', (e) => this.onFileListKeyDown(e));
    tree.appendChild(this.fileList);

    this.container.appendChild(tree);

    const resizer = document.createElement('div');
    resizer.className = 'explorer-resizer';
    resizer.addEventListener('pointerdown', (e) => this.startResize(e));
    this.container.appendChild(resizer);

    this.contextMenu = document.createElement('div');
    this.contextMenu.className = 'explorer-context-menu';
    this.contextMenu.hidden = true;
    document.body.appendChild(this.contextMenu);

    document.addEventListener('click', () => this.hideContextMenu());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideContextMenu();
      }
    });
    window.addEventListener('scroll', () => this.hideContextMenu(), true);

    this.width = readStoredNumber(WIDTH_KEY, DEFAULT_WIDTH);
    this.applyWidth();

    const storedCollapsed = readStorage(COLLAPSED_KEY);
    // On narrow screens the sidebar starts out of the way unless the user chose otherwise.
    this.setCollapsed(
      storedCollapsed != null ? storedCollapsed === 'true' : window.innerWidth < 800,
    );
  }

  render() {
    const folders = new Map<string, { name: string; dataPath?: string }[]>([['src', []]]);
    for (const fileName of sortFileNames(Object.keys(this.getSources()))) {
      folders.get('src')!.push({ name: fileName });
    }
    const dataPaths = Object.keys(this.getDataFiles() ?? {}).sort((a, b) =>
      dataFileDisplayPath(a).localeCompare(dataFileDisplayPath(b)),
    );
    for (const dataPath of dataPaths) {
      const display = dataFileDisplayPath(dataPath);
      const slash = display.lastIndexOf('/');
      const folder = slash < 0 ? '' : display.slice(0, slash);
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder)!.push({ name: display.slice(slash + 1), dataPath });
    }

    const hadFocus = this.fileList.contains(document.activeElement);
    this.fileList.innerHTML = '';

    for (const [folder, files] of folders) {
      // Root-level data files have no folder row
      const expanded = folder === '' || !this.collapsedFolders.has(folder);
      if (folder !== '') {
        const folderRow = document.createElement('button');
        folderRow.className = 'explorer-folder';
        folderRow.innerHTML = `${expanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT}<span></span>`;
        folderRow.querySelector('span')!.textContent = folder;
        folderRow.setAttribute('aria-expanded', String(expanded));
        folderRow.addEventListener('click', () => {
          if (expanded) this.collapsedFolders.add(folder);
          else this.collapsedFolders.delete(folder);
          this.render();
        });
        this.fileList.appendChild(folderRow);
      }
      if (!expanded) continue;
      for (const file of files) {
        this.fileList.appendChild(
          file.dataPath != null
            ? this.dataFileRow(file.name, file.dataPath)
            : this.sourceRow(file.name),
        );
      }
    }

    if (hadFocus) {
      this.activeRow()?.focus();
    }
  }

  private sourceRow(fileName: string) {
    const markers = this.markersPerFile[fileName] ?? [];
    const errorCount = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
    const row = this.fileRow(
      fileName,
      fileName,
      this.currentDataFile == null && fileName === this.currentFileName,
    );
    row.dataset.fileName = fileName;

    if (errorCount > 0) {
      row.classList.add('has-errors');
    } else if (markers.length > 0) {
      row.classList.add('has-warnings');
    }

    if (markers.length > 0) {
      const badge = document.createElement('span');
      badge.className = 'file-badge';
      badge.textContent = String(errorCount > 0 ? errorCount : markers.length);
      badge.title = `${markers.length} problem${markers.length === 1 ? '' : 's'}`;
      row.appendChild(badge);
    }

    row.addEventListener('click', () => {
      if (this.currentDataFile != null || fileName !== this.currentFileName) {
        this.switchTo(fileName);
      }
    });
    row.addEventListener('contextmenu', (e) => this.showContextMenu(e, fileName));
    return row;
  }

  private dataFileRow(name: string, dataPath: string) {
    const row = this.fileRow(
      name,
      dataFileDisplayPath(dataPath),
      dataPath === this.currentDataFile,
    );
    row.dataset.dataPath = dataPath;
    row.addEventListener('click', () => {
      if (dataPath !== this.currentDataFile) {
        this.openDataFile(dataPath);
      }
    });
    return row;
  }

  private fileRow(label: string, title: string, isActive: boolean) {
    const row = document.createElement('div');
    row.className = 'explorer-file';
    row.setAttribute('role', 'treeitem');
    row.title = title;
    row.tabIndex = isActive ? 0 : -1;
    if (isActive) {
      row.classList.add('active');
      row.setAttribute('aria-selected', 'true');
    }

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.innerHTML = ICON_FILE;
    row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = label;
    row.appendChild(name);
    return row;
  }

  /** Writes the editor's contents back to whichever file is open. */
  private saveCurrent() {
    const value = this.getEditorValue();
    const dataFiles = this.getDataFiles();
    if (this.currentDataFile != null && dataFiles) {
      dataFiles[this.currentDataFile] = value;
    } else {
      this.getSources()[this.currentFileName] = value;
    }
  }

  /** Points the explorer at a source file of a freshly loaded project, without saving. */
  resetTo(fileName: string) {
    this.currentFileName = fileName;
    this.currentDataFile = null;
    monaco.editor.setModelLanguage(this.editorModel, 'systemverilog');
  }

  openDataFile(dataPath: string) {
    this.saveCurrent();
    this.currentDataFile = dataPath;
    monaco.editor.setModelLanguage(this.editorModel, 'plaintext');
    this.setEditorValue(this.getDataFiles()?.[dataPath] ?? '');
    this.render();
    this.updateEditorMarkers();
  }

  switchTo(fileName: string) {
    this.saveCurrent();
    this.currentFileName = fileName;
    this.currentDataFile = null;
    monaco.editor.setModelLanguage(this.editorModel, 'systemverilog');
    this.setEditorValue(this.getSources()[this.currentFileName]);
    this.render();
    this.updateEditorMarkers();
  }

  updateMarkers(errors: IErrorMessage[]) {
    for (const key of Object.keys(this.markersPerFile)) {
      delete this.markersPerFile[key];
    }
    for (const e of errors) {
      const file = e.file.replace(/^src\//, '');
      if (!this.markersPerFile[file]) {
        this.markersPerFile[file] = [];
      }
      this.markersPerFile[file].push(toMarker(e));
    }
    this.updateEditorMarkers();
    this.render();
  }

  updateEditorMarkers() {
    const markers =
      this.currentDataFile == null ? this.markersPerFile[this.currentFileName] ?? [] : [];
    monaco.editor.setModelMarkers(this.editorModel, 'error', markers);
  }

  setCollapsed(collapsed: boolean) {
    this.collapsed = collapsed;
    this.container.classList.toggle('collapsed', collapsed);
    this.collapseButton.innerHTML = collapsed ? ICON_EXPAND : ICON_COLLAPSE;
    this.collapseButton.title = collapsed ? 'Show explorer' : 'Hide explorer';
    this.collapseButton.setAttribute('aria-label', this.collapseButton.title);
    this.applyWidth();
    writeStorage(COLLAPSED_KEY, String(collapsed));
  }

  private applyWidth() {
    this.container.style.width = this.collapsed ? '' : `${this.width}px`;
  }

  private startResize(e: PointerEvent) {
    if (this.collapsed) return;
    e.preventDefault();
    const resizer = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startWidth = this.container.getBoundingClientRect().width;
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('explorer-resizing');

    const onMove = (ev: PointerEvent) => {
      const next = startWidth + (ev.clientX - startX);
      this.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next));
      this.applyWidth();
    };
    const onUp = () => {
      resizer.removeEventListener('pointermove', onMove);
      resizer.removeEventListener('pointerup', onUp);
      resizer.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('explorer-resizing');
      writeStorage(WIDTH_KEY, String(Math.round(this.width)));
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onUp);
    resizer.addEventListener('pointercancel', onUp);
  }

  private activeRow() {
    return this.fileList.querySelector<HTMLElement>('.explorer-file.active');
  }

  private onFileListKeyDown(e: KeyboardEvent) {
    const rows = Array.from(this.fileList.querySelectorAll<HTMLElement>('.explorer-file'));
    const index = rows.findIndex((row) => row === document.activeElement);
    if (index < 0) return;
    // Data files can be opened but not renamed or deleted
    const fileName = rows[index].dataset.fileName;

    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const next = rows[index + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) {
          if (next.dataset.dataPath != null) {
            this.openDataFile(next.dataset.dataPath);
          } else {
            this.switchTo(next.dataset.fileName!);
          }
          this.activeRow()?.focus();
        }
        break;
      }
      case 'F2':
        if (fileName == null) break;
        e.preventDefault();
        this.renameFile(fileName);
        break;
      case 'Delete':
        if (fileName == null) break;
        e.preventDefault();
        this.deleteFile(fileName);
        break;
    }
  }

  private createFile() {
    const name = prompt(`New file name (${VALID_EXTENSIONS.join(', ')}):`, 'new_module.v');
    if (!name) return;
    if (!isValidFileName(name)) {
      alert(`File name must end with one of: ${VALID_EXTENSIONS.join(', ')}`);
      return;
    }
    const sources = this.getSources();
    if (sources[name] != null) {
      alert('A file with that name already exists');
      return;
    }
    this.saveCurrent();
    sources[name] = '';
    this.currentFileName = name;
    this.currentDataFile = null;
    monaco.editor.setModelLanguage(this.editorModel, 'systemverilog');
    this.setEditorValue('');
    this.collapsedFolders.delete('src');
    this.render();
  }

  private renameFile(fileName: string) {
    const newName = prompt('Rename file:', fileName);
    if (!newName || newName === fileName) return;
    if (!isValidFileName(newName)) {
      alert(`File name must end with one of: ${VALID_EXTENSIONS.join(', ')}`);
      return;
    }
    const sources = this.getSources();
    if (sources[newName] != null) {
      alert('A file with that name already exists');
      return;
    }
    const content = sources[fileName];
    delete sources[fileName];
    sources[newName] = content;
    if (this.currentFileName === fileName) {
      this.currentFileName = newName;
    }
    this.render();
  }

  private deleteFile(fileName: string) {
    const sources = this.getSources();
    if (Object.keys(sources).length <= 1) return;
    if (!confirm(`Delete "${fileName}"?`)) return;
    delete sources[fileName];
    if (this.currentFileName === fileName) {
      this.currentFileName = sortFileNames(Object.keys(sources))[0];
      if (this.currentDataFile == null) {
        this.setEditorValue(sources[this.currentFileName]);
      }
    }
    this.render();
  }

  private hideContextMenu() {
    this.contextMenu.hidden = true;
  }

  private showContextMenu(e: MouseEvent, fileName: string) {
    e.preventDefault();
    this.contextMenu.innerHTML = '';

    const addItem = (label: string, hint: string, action: () => void) => {
      const item = document.createElement('div');
      item.className = 'explorer-context-menu-item';
      item.innerHTML = `<span>${label}</span><span class="menu-hint">${hint}</span>`;
      item.addEventListener('click', action);
      this.contextMenu.appendChild(item);
    };

    addItem('Rename', 'F2', () => this.renameFile(fileName));
    if (Object.keys(this.getSources()).length > 1) {
      addItem('Delete', 'Del', () => this.deleteFile(fileName));
    }

    this.contextMenu.hidden = false;
    const { width, height } = this.contextMenu.getBoundingClientRect();
    this.contextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - width - 4)}px`;
    this.contextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - height - 4)}px`;
  }
}

/** Maps a $readmem path (relative to src/) to its path from the project root. */
export function dataFileDisplayPath(path: string) {
  const resolved: string[] = [];
  for (const part of `src/${path}`.split('/')) {
    if (part === '..') resolved.pop();
    else if (part !== '.' && part !== '') resolved.push(part);
  }
  return resolved.join('/');
}

/** Keeps the project's entry file on top, then sorts the rest like a file tree. */
function sortFileNames(names: string[]) {
  const [first, ...rest] = names;
  rest.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return first != null ? [first, ...rest] : [];
}

function toMarker(e: {
  line: number;
  column: number;
  endColumn?: number;
  message: string;
  type: string;
}): MarkerData {
  return {
    startLineNumber: e.line,
    endLineNumber: e.line,
    startColumn: e.column,
    endColumn: e.endColumn ?? 999,
    message: e.message,
    severity: e.type === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
  };
}
