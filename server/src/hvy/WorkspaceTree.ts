import {
    IConnection, RequestType
} from 'vscode-languageserver';

import { TreeBuilder, FileNode, ClassNode } from './treeBuilder';
import { Debug } from '../util/Debug';

const fs = require('fs');
const util = require('util');
const zlib = require('zlib');

const FileQueue = require('filequeue');
const fq = new FileQueue(200);

export class WorkspaceTree {

    public static enableCache: boolean = true;
    public static tree: FileNode[] = [];

    protected stubsToDo: string[] = [];
    protected treeBuilder: TreeBuilder;

    protected docsDoneCount = 0;
    protected docsToDo: string[] = [];

    protected connection: IConnection;

    public constructor(treeBuilder: TreeBuilder, connection: IConnection) {
        this.treeBuilder = treeBuilder;
        this.connection = connection;
    }

    public setStubs(stubs: string[]) {
        this.stubsToDo = stubs;
    }

    public get stubCount() {
        return this.stubsToDo.length;
    }

    public get docsToDoCount() {
        return this.docsToDo.length;
    }

    public setDocsToDo(docs: string[]) {
        this.docsToDo = docs;
        this.docsDoneCount = 0;
    }

    public addToWorkspaceTree(tree: FileNode): void {

        // Loop through existing filenodes and replace if exists, otherwise add
        var fileNode = WorkspaceTree.tree.filter((fileNode) => {
            return fileNode.path == tree.path;
        })[0];

        var index = WorkspaceTree.tree.indexOf(fileNode);

        if (index !== -1) {
            WorkspaceTree.tree[index] = tree;
        } else {
            WorkspaceTree.tree.push(tree);
        }

    }

    public clearTree() {
        WorkspaceTree.tree = [];
    }

    public removeFromWorkspaceTree(tree: FileNode) {
        var index: number = WorkspaceTree.tree.indexOf(tree);
        if (index > -1) {
            WorkspaceTree.tree.splice(index, 1);
        }
    }

    public getClassNodeFromTree(className:string): ClassNode {
        var toReturn = null;

        var fileNode = WorkspaceTree.tree.forEach((fileNode) => {
            fileNode.classes.forEach((classNode) => {
                if (classNode.name.toLowerCase() == className.toLowerCase()) {
                    toReturn = classNode;
                }
            })
        });

        return toReturn;
    }

    public getTraitNodeFromTree(traitName: string): ClassNode {
        var toReturn = null;

        var fileNode = WorkspaceTree.tree.forEach((fileNode) => {
            fileNode.traits.forEach((traitNode) => {
                if (traitNode.name.toLowerCase() == traitName.toLowerCase()) {
                    toReturn = traitNode;
                }
            })
        });

        return toReturn;
    }

    public getFileNodeFromPath(path: string): FileNode {
        var returnNode = null;

        WorkspaceTree.tree.forEach(fileNode => {
            if (fileNode.path == path) {
                returnNode = fileNode;
            }
        });

        return returnNode;
    }

    /**
     * Finds the Usings in a file
     */
    public getFileUsings(path: string): string[] {
        var node = this.getFileNodeFromPath(path);

        var namespaces: string[] = [];
        node.classes.forEach(item => {
            let ns: string = item.namespaceParts.join('\\');
            if (ns.length > 0 && namespaces.indexOf(ns) == -1) {
                namespaces.push(ns);
            }
        });

        node.traits.forEach(item => {
            let ns: string = item.namespaceParts.join('\\');
            if (ns.length > 0 && namespaces.indexOf(ns) == -1) {
                namespaces.push(ns);
            }
        });

        node.namespaceUsings.forEach(item => {
            let ns: string = item.parents.join('\\');
            if (ns.length > 0 && namespaces.indexOf(ns) == -1) {
                namespaces.push(ns);
            }
        });

        return namespaces;
    }

    public saveProjectTree(projectPath: string, treeFile: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            if (!WorkspaceTree.enableCache) {
                resolve(false);
            } else {
                Debug.info('Packing tree file: ' + treeFile);
                fq.writeFile(`${projectPath}/tree.tmp`, JSON.stringify(WorkspaceTree.tree), (err) => {
                    if (err) {
                        Debug.error('Could not write to cache file');
                        Debug.error(util.inspect(err, false, null));
                        resolve(false);
                    } else {
                        var gzip = zlib.createGzip();
                        var inp = fs.createReadStream(`${projectPath}/tree.tmp`);
                        var out = fs.createWriteStream(treeFile);
                        inp.pipe(gzip).pipe(out).on('close', function () {
                            fs.unlinkSync(`${projectPath}/tree.tmp`);
                        });
                        Debug.info('Cache file updated');
                        resolve(true);
                    }
                });
            }
        });
    }

    public loadProjectTree(treeStream: Buffer): Thenable<boolean> {
        return new Promise((resolve, reject) => {
            zlib.gunzip(treeStream, (err, buffer) => {
                if (err) {
                    Debug.error('Could not unzip cache file');
                    Debug.error((util.inspect(err, false, null)));
                    resolve(false);
                } else {
                    Debug.info('Cache file successfully read');
                    WorkspaceTree.tree = JSON.parse(buffer.toString());
                    Debug.info('Loaded');
                    resolve(true);
                }
            });
        });
    }

    /**
     * Processes the stub files
     */
    public processStub() {
        return new Promise((resolve, reject) => {
            var offset: number = 0;
            if (this.stubsToDo.length == 0) {
                reject();
            }
            this.stubsToDo.forEach(file => {
                fq.readFile(file, { encoding: 'utf8' }, (err, data) => {
                    this.treeBuilder.Parse(data, file).then(result => {
                        this.addToWorkspaceTree(result.tree);
                        this.connection.console.log(`${offset} Stub Processed: ${file}`);
                        offset++;
                        if (offset == this.stubsToDo.length) {
                            resolve();
                        }
                    }).catch(err => {
                        this.connection.console.log(`${offset} Stub Error: ${file}`);
                        Debug.error((util.inspect(err, false, null)));
                        offset++;
                        if (offset == this.stubsToDo.length) {
                            resolve();
                        }
                    });
                });
            });
        });
    }

    /**
     * Processes the users workspace files
     */
    public processWorkspaceFiles(projectPath: string, treePath: string) {
        this.docsToDo.forEach(file => {
            fq.readFile(file, { encoding: 'utf8' }, (err, data) => {
                this.treeBuilder.Parse(data, file).then(result => {
                    this.addToWorkspaceTree(result.tree);
                    this.docsDoneCount++;
                    this.connection.console.log(`(${this.docsDoneCount} of ${this.docsToDo.length}) File: ${file}`);
                    this.connection.sendNotification({ method: "fileProcessed" }, { filename: file, total: this.docsDoneCount, error: null });
                    if (this.docsToDo.length == this.docsDoneCount) {
                        this.workspaceProcessed(projectPath, treePath);
                    }
                }).catch(data => {
                    this.docsDoneCount++;
                    if (this.docsToDo.length == this.docsDoneCount) {
                        this.workspaceProcessed(projectPath, treePath);
                    }
                    this.connection.console.log(util.inspect(data, false, null));
                    this.connection.console.log(`Issue processing ${file}`);
                    this.connection.sendNotification({ method: "fileProcessed" }, { filename: file, total: this.docsDoneCount, error: util.inspect(data, false, null) });
                });
            });
        });
    }

    public workspaceProcessed(projectPath, treePath) {
        Debug.info("Workspace files have processed");
        this.saveProjectTree(projectPath, treePath).then(savedTree => {
            this.notifyClientOfWorkComplete();
            if (savedTree) {
                Debug.info('Project tree has been saved');
            }
        }).catch(error => {
            Debug.error(util.inspect(error, false, null));
        });
    }

    public notifyClientOfWorkComplete() {
        var requestType: RequestType<any, any, any> = { method: "workDone" };
        this.connection.sendRequest(requestType);
    }

}