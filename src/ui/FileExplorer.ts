import * as monaco from 'monaco-editor';
import { dataFileDisplayPath, dataFileKey, parseDataFilePath } from '../dataFiles';
import { IErrorMessage } from '../verilator/ErrorParser';
import { readStorage, readStoredNumber, writeStorage } from './storage';

type MarkerData = monaco.editor.IMarkerData;

export interface FileExplorerOptions {
  container: HTMLElement;
  editorModel: monaco.editor.ITextModel;
  getSources: () => Record<string, string>;
  /** Files read via $readmem, keyed by the path as written (relative to src/) */
  getDataFiles: () => Record<string, string>;
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

interface ContextMenuItem {
  label: string;
  hint: string;
  action: () => void;
}

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
  private readonly getDataFiles: () => Record<string, string>;
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
    const dataPaths = Object.keys(this.getDataFiles()).sort((a, b) =>
      dataFileDisplayPath(a).localeCompare(dataFileDisplayPath(b)),
    );
    for (const dataPath of dataPaths) {
      const display = dataFileDisplayPath(dataPath);
      const folder = folderOf(display);
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder)!.push({ name: display.slice(display.lastIndexOf('/') + 1), dataPath });
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
        folderRow.addEventListener('contextmenu', (e) =>
          this.showContextMenu(e, [
            { label: 'New File...', hint: '', action: () => this.createFile(folder) },
          ]),
        );
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
    row.addEventListener('contextmenu', (e) => {
      const items = [{ label: 'Rename', hint: 'F2', action: () => this.renameFile(fileName) }];
      if (Object.keys(this.getSources()).length > 1) {
        items.push({ label: 'Delete', hint: 'Del', action: () => this.deleteFile(fileName) });
      }
      this.showContextMenu(e, items);
    });
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
    row.addEventListener('contextmenu', (e) =>
      this.showContextMenu(e, [
        { label: 'Rename', hint: 'F2', action: () => this.renameDataFile(dataPath) },
        { label: 'Delete', hint: 'Del', action: () => this.deleteDataFile(dataPath) },
      ]),
    );
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
    if (this.currentDataFile != null) {
      this.getDataFiles()[this.currentDataFile] = value;
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
    this.setEditorValue(this.getDataFiles()[dataPath] ?? '');
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
    const { fileName, dataPath } = rows[index].dataset;

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
        e.preventDefault();
        if (dataPath != null) this.renameDataFile(dataPath);
        else if (fileName != null) this.renameFile(fileName);
        break;
      case 'Delete':
        e.preventDefault();
        if (dataPath != null) this.deleteDataFile(dataPath);
        else if (fileName != null) this.deleteFile(fileName);
        break;
    }
  }

  /**
   * Asks for a file name and creates it: a Verilog source in src/, or any other
   * file as a $readmem data file at that path from the project root.
   */
  private createFile(folder = '') {
    const input = prompt(
      `New file name: a Verilog file in src/ (${VALID_EXTENSIONS.join(', ')}), ` +
        `or a data file for $readmem with its path from the project root (e.g. data/image.mem):`,
      folder === '' || folder === 'src' ? 'new_module.v' : `${folder}/`,
    );
    if (!input) return;
    const name = input.trim().replace(/^src\//, '');
    if (isValidFileName(name)) {
      this.createSourceFile(name);
    } else {
      this.createDataFile(input);
    }
  }

  private createSourceFile(name: string) {
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
    this.updateEditorMarkers();
  }

  private createDataFile(input: string) {
    const displayPath = this.promptedDataFilePath(input);
    if (displayPath == null) return;
    this.saveCurrent();
    const dataPath = dataFileKey(displayPath);
    this.getDataFiles()[dataPath] = '';
    this.currentDataFile = dataPath;
    monaco.editor.setModelLanguage(this.editorModel, 'plaintext');
    this.setEditorValue('');
    this.collapsedFolders.delete(folderOf(displayPath));
    this.render();
    this.updateEditorMarkers();
  }

  /**
   * Validates a data file path the user typed, alerting if it's unusable.
   *
   * @returns the path from the project root, or null if it was rejected
   */
  private promptedDataFilePath(input: string, ignore?: string) {
    const parsed = parseDataFilePath(input);
    if ('error' in parsed) {
      alert(parsed.error);
      return null;
    }
    const taken =
      Object.keys(this.getDataFiles()).some(
        (key) => key !== ignore && dataFileDisplayPath(key) === parsed.path,
      ) || this.getSources()[parsed.path.replace(/^src\//, '')] != null;
    if (taken) {
      alert('A file with that name already exists');
      return null;
    }
    return parsed.path;
  }

  private renameDataFile(dataPath: string) {
    const oldPath = dataFileDisplayPath(dataPath);
    const input = prompt('Rename file:', oldPath);
    if (!input || input.trim() === oldPath) return;
    const displayPath = this.promptedDataFilePath(input, dataPath);
    if (displayPath == null) return;
    const dataFiles = this.getDataFiles();
    const newDataPath = dataFileKey(displayPath);
    if (this.currentDataFile === dataPath) {
      this.saveCurrent();
      this.currentDataFile = newDataPath;
    }
    const content = dataFiles[dataPath];
    delete dataFiles[dataPath];
    dataFiles[newDataPath] = content;
    this.render();
  }

  private deleteDataFile(dataPath: string) {
    if (!confirm(`Delete "${dataFileDisplayPath(dataPath)}"?`)) return;
    delete this.getDataFiles()[dataPath];
    if (this.currentDataFile === dataPath) {
      this.currentDataFile = null;
      monaco.editor.setModelLanguage(this.editorModel, 'systemverilog');
      this.setEditorValue(this.getSources()[this.currentFileName]);
      this.updateEditorMarkers();
    }
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

  private showContextMenu(e: MouseEvent, items: ContextMenuItem[]) {
    e.preventDefault();
    this.contextMenu.innerHTML = '';

    for (const { label, hint, action } of items) {
      const item = document.createElement('div');
      item.className = 'explorer-context-menu-item';
      item.innerHTML = `<span>${label}</span><span class="menu-hint">${hint}</span>`;
      item.addEventListener('click', action);
      this.contextMenu.appendChild(item);
    }

    this.contextMenu.hidden = false;
    const { width, height } = this.contextMenu.getBoundingClientRect();
    this.contextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - width - 4)}px`;
    this.contextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - height - 4)}px`;
  }
}

/** The folder a path from the project root is shown in ('' for the root). */
function folderOf(displayPath: string) {
  const slash = displayPath.lastIndexOf('/');
  return slash < 0 ? '' : displayPath.slice(0, slash);
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
