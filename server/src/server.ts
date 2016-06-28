/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hvy Industries. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  "HVY", "HVY Industries" and "Hvy Industries" are trading names of JCKD (UK) Ltd
 *--------------------------------------------------------------------------------------------*/

'use strict';

import {
    IPCMessageReader, IPCMessageWriter, SymbolKind,
    createConnection, IConnection, TextDocumentSyncKind,
    TextDocuments, ITextDocument, Diagnostic, DiagnosticSeverity,
    InitializeParams, InitializeResult, TextDocumentIdentifier, TextDocumentPosition,
    CompletionItem, CompletionItemKind, RequestType, Position,
    SignatureHelp, SignatureInformation, ParameterInformation
} from 'vscode-languageserver';

import { TreeBuilder, FileNode, FileSymbolCache, SymbolType, AccessModifierNode, ClassNode } from "./hvy/treeBuilder";
import { Debug } from './util/Debug';
import { SuggestionBuilder } from './suggestionBuilder';
import { WorkspaceTree } from './hvy/WorkspaceTree';

const fs = require("fs");
const util = require('util');

// Glob for file searching
const glob = require("glob");
// FileQueue for queuing files so we don't open too many
const FileQueue = require('filequeue');
const fq = new FileQueue(200);

let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

let documents: TextDocuments = new TextDocuments();
documents.listen(connection);
Debug.SetConnection(connection);

let treeBuilder: TreeBuilder = new TreeBuilder();
treeBuilder.SetConnection(connection);

let workspaceTree = new WorkspaceTree(treeBuilder, connection);

let workspaceRoot: string;
var craneProjectDir: string;

connection.onInitialize((params): InitializeResult =>
{
    workspaceRoot = params.rootPath;

    return {
        capabilities:
        {
            textDocumentSync: documents.syncKind,
            completionProvider:
            {
                resolveProvider: true,
                triggerCharacters: ['.', ':', '$', '>']
            }
        }
    }
});

// The settings interface describe the server relevant settings part
interface Settings {
    languageServerExample: ExampleSettings;
}

// These are the example settings we defined in the client's package.json
// file
interface ExampleSettings {
    maxNumberOfProblems: number;
}

// hold the maxNumberOfProblems setting
let maxNumberOfProblems: number;
// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration((change) =>
{
    let settings = <Settings>change.settings;
    maxNumberOfProblems = settings.languageServerExample.maxNumberOfProblems || 100;
    // Revalidate any open text documents
    //documents.all().forEach(validateTextDocument);
});

// Use this to send a request to the client
// https://github.com/Microsoft/vscode/blob/80bd73b5132268f68f624a86a7c3e56d2bbac662/extensions/json/client/src/jsonMain.ts
// https://github.com/Microsoft/vscode/blob/580d19ab2e1fd6488c3e515e27fe03dceaefb819/extensions/json/server/src/server.ts
//connection.sendRequest()

connection.onDidChangeWatchedFiles((change) =>
{
    // Monitored files have change in VSCode
    connection.console.log('We recevied an file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion((textDocumentPosition: TextDocumentPosition): CompletionItem[] =>
{
    if (textDocumentPosition.languageId != "php") return;

    var doc = documents.get(textDocumentPosition.uri);
    var suggestionBuilder = new SuggestionBuilder();

    suggestionBuilder.prepare(textDocumentPosition, doc, WorkspaceTree.tree);

    var toReturn: CompletionItem[] = suggestionBuilder.build();

    return toReturn;
});

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem =>
{
    // TODO -- Add phpDoc info
    // if (item.data === 1) {
    //     item.detail = 'TypeScript details',
    //     item.documentation = 'TypeScript documentation'
    // } else if (item.data === 2) {
    //     item.detail = 'JavaScript details',
    //     item.documentation = 'JavaScript documentation'
    // }
    return item;
});
var buildObjectTreeForDocument: RequestType<{ path: string, text: string }, any, any> = { method: "buildObjectTreeForDocument" };
connection.onRequest(buildObjectTreeForDocument, (requestObj) =>
{
    var fileUri = requestObj.path;
    var text = requestObj.text;

    treeBuilder.Parse(text, fileUri).then(result => {
        workspaceTree.addToWorkspaceTree(result.tree);
        return true;
    }).catch(error => {
        console.log(error);
        workspaceTree.notifyClientOfWorkComplete();
        return false;
    });
});
/**
 * Finds all the symbols in a particular file
 */
var findFileDocumentSymbols: RequestType<{path:string}, any, any> = { method: "findFileDocumentSymbols" };
connection.onRequest(findFileDocumentSymbols, (requestObj) => {
    var node = workspaceTree.getFileNodeFromPath(requestObj.path);
    return { symbols: node.symbolCache };
});

/**
 * Finds all the symbols in the workspace
 */
var findWorkspaceSymbols: RequestType<{query:string,path:string}, any, any> = { method: "findWorkspaceSymbols" };
connection.onRequest(findWorkspaceSymbols, (requestObj) => {

    let query: string = requestObj.query;

    let symbols: FileSymbolCache[] = [];
    let usings: string[] = workspaceTree.getFileUsings(requestObj.path);

    WorkspaceTree.tree.forEach(item => {
        // Search The interfaces
        item.interfaces.forEach(interfaceNode => {
            let ns: string = interfaceNode.namespaceParts.join('\\');
            if (interfaceNode.name == query && (usings.indexOf(ns) != -1 || usings.length == 0)) {
                let symbol: FileSymbolCache = new FileSymbolCache();
                symbol.kind = SymbolKind.Class;
                symbol.startLine = interfaceNode.startPos.line;
                symbol.startChar = interfaceNode.startPos.col;
                symbol.endLine = interfaceNode.endPos.line;
                symbol.endChar = interfaceNode.endPos.col;
                symbol.path = item.path;
                symbols.push(symbol);
            }
            // Search the methods within the interface
            interfaceNode.methods.forEach(methodNode => {
                if (methodNode.name == query && (usings.indexOf(ns) != -1 || usings.length == 0)) {
                    let symbol: FileSymbolCache = new FileSymbolCache();
                    symbol.kind = SymbolKind.Method;
                    symbol.startLine = methodNode.startPos.line;
                    symbol.startChar = methodNode.startPos.col;
                    symbol.endLine = methodNode.endPos.line;
                    symbol.endChar = methodNode.endPos.col;
                    symbol.parentName = interfaceNode.name;
                    symbol.path = item.path;
                    symbols.push(symbol);
                }
            });
            // Search the constants within the interface
            interfaceNode.constants.forEach(constNode => {
                if (constNode.name == query && (usings.indexOf(ns) != -1 || usings.length == 0)) {
                    let symbol: FileSymbolCache = new FileSymbolCache();
                    symbol.kind = SymbolKind.Constant;
                    symbol.startLine = constNode.startPos.line;
                    symbol.startChar = constNode.startPos.col;
                    symbol.endLine = constNode.endPos.line;
                    symbol.endChar = constNode.endPos.col;
                    symbol.parentName = interfaceNode.name;
                    symbol.path = item.path;
                    symbols.push(symbol);
                }
            });
        });
        // Search the traits
        item.traits.forEach(traitNode => {
            let ns: string = traitNode.namespaceParts.join('\\');
            if (traitNode.name == query && (usings.indexOf(ns) != -1 || usings.length == 0)) {
                let symbol: FileSymbolCache = new FileSymbolCache();
                symbol.kind = SymbolKind.Class;
                symbol.startLine = traitNode.startPos.line;
                symbol.startChar = traitNode.startPos.col;
                symbol.endLine = traitNode.endPos.line;
                symbol.endChar = traitNode.endPos.col;
                symbol.path = item.path;
                symbols.push(symbol);
            }
            // Search the methods within the traits
            traitNode.methods.forEach(methodNode => {
                if (methodNode.name == query && (usings.indexOf(ns) != -1 || usings.length == 0)) {
                    let symbol: FileSymbolCache = new FileSymbolCache();
                    symbol.kind = SymbolKind.Method;
                    symbol.startLine = methodNode.startPos.line;
                    symbol.startChar = methodNode.startPos.col;
                    symbol.endLine = methodNode.endPos.line;
                    symbol.endChar = methodNode.endPos.col;
                    symbol.parentName = traitNode.name;
                    symbol.path = item.path;
                    symbols.push(symbol);
                }
            });
            // Search the properties within the traits
            traitNode.properties.forEach(propertyNode => {
                if (propertyNode.name == query && (usings.indexOf(ns) != -1 || usings.length == 0)) {
                    let symbol: FileSymbolCache = new FileSymbolCache();
                    symbol.kind = SymbolKind.Property;
                    symbol.startLine = propertyNode.startPos.line;
                    symbol.startChar = propertyNode.startPos.col;
                    symbol.endLine = propertyNode.endPos.line;
                    symbol.endChar = propertyNode.endPos.col;
                    symbol.parentName = traitNode.name;
                    symbol.path = item.path;
                    symbols.push(symbol);
                }
            });
            // Search the constants within the trait
            traitNode.constants.forEach(constNode => {
                if (constNode.name == query && (usings.indexOf(ns) != -1 || usings.length == 0)) {
                    let symbol: FileSymbolCache = new FileSymbolCache();
                    symbol.kind = SymbolKind.Constant;
                    symbol.startLine = constNode.startPos.line;
                    symbol.startChar = constNode.startPos.col;
                    symbol.endLine = constNode.endPos.line;
                    symbol.endChar = constNode.endPos.col;
                    symbol.parentName = traitNode.name;
                    symbol.path = item.path;
                    symbols.push(symbol);
                }
            });
        });
        // Search the classes
        item.classes.forEach(classNode => {
            let ns: string = classNode.namespaceParts.join('\\');
            if (classNode.name == query && (usings.indexOf(ns) != -1 || usings.length == 0)) {
                let symbol: FileSymbolCache = new FileSymbolCache();
                symbol.kind = SymbolKind.Class;
                symbol.startLine = classNode.startPos.line;
                symbol.startChar = classNode.startPos.col;
                symbol.endLine = classNode.endPos.line;
                symbol.endChar = classNode.endPos.col;
                symbol.path = item.path;
                symbols.push(symbol);
            }
            // Search the methods within the classes
            classNode.methods.forEach(methodNode => {
                if (methodNode.name == query && (usings.indexOf(ns) != -1 || usings.length == 0)) {
                    let symbol: FileSymbolCache = new FileSymbolCache();
                    symbol.kind = SymbolKind.Method;
                    symbol.startLine = methodNode.startPos.line;
                    symbol.startChar = methodNode.startPos.col;
                    symbol.endLine = methodNode.endPos.line;
                    symbol.endChar = methodNode.endPos.col;
                    symbol.parentName = classNode.name;
                    symbol.path = item.path;
                    symbols.push(symbol);
                }
            });
            // Search the properties within the classes
            classNode.properties.forEach(propertyNode => {
                if (propertyNode.name == query && (usings.indexOf(ns) != -1 || usings.length == 0)) {
                    let symbol: FileSymbolCache = new FileSymbolCache();
                    symbol.kind = SymbolKind.Property;
                    symbol.startLine = propertyNode.startPos.line;
                    symbol.startChar = propertyNode.startPos.col;
                    symbol.endLine = propertyNode.endPos.line;
                    symbol.endChar = propertyNode.endPos.col;
                    symbol.parentName = classNode.name;
                    symbol.path = item.path;
                    symbols.push(symbol);
                }
            });
            // Search the constants within the class
            classNode.constants.forEach(constNode => {
                if (constNode.name == query && (usings.indexOf(ns) != -1 || usings.length == 0)) {
                    let symbol: FileSymbolCache = new FileSymbolCache();
                    symbol.kind = SymbolKind.Constant;
                    symbol.startLine = constNode.startPos.line;
                    symbol.startChar = constNode.startPos.col;
                    symbol.endLine = constNode.endPos.line;
                    symbol.endChar = constNode.endPos.col;
                    symbol.parentName = classNode.name;
                    symbol.path = item.path;
                    symbols.push(symbol);
                }
            });
        });
        item.functions.forEach(funcNode => {
            if (funcNode.name == query) {
                let symbol: FileSymbolCache = new FileSymbolCache();
                symbol.kind = SymbolKind.Function;
                symbol.startLine = funcNode.startPos.line;
                symbol.startChar = funcNode.startPos.col;
                symbol.endLine = funcNode.endPos.line;
                symbol.endChar = funcNode.endPos.col;
                symbol.path = item.path;
                symbols.push(symbol);
            }
        });
    });

    return { symbols: symbols };
});

var deleteFile: RequestType<{path:string}, any, any> = { method: "deleteFile" };
connection.onRequest(deleteFile, (requestObj) =>
{
    var node = workspaceTree.getFileNodeFromPath(requestObj.path);
    if (node instanceof FileNode) {
        workspaceTree.removeFromWorkspaceTree(node);
    }
});

var saveTreeCache: RequestType<{ projectDir: string, projectTree: string }, any, any> = { method: "saveTreeCache" };
connection.onRequest(saveTreeCache, request => {
    workspaceTree.saveProjectTree(request.projectDir, request.projectTree).then(saved => {
        workspaceTree.notifyClientOfWorkComplete();
    }).catch(error => {
        Debug.error(util.inspect(error, false, null));
    });
});

var buildFromFiles: RequestType<{
    files: string[],
    craneRoot: string,
    projectPath: string,
    treePath: string,
    enableCache: boolean,
    rebuild: boolean
}, any, any> = { method: "buildFromFiles" };
connection.onRequest(buildFromFiles, (project) => {
    Debug.info('Building Tree From Files');
    if (project.rebuild) {
        workspaceTree.clearTree();
        treeBuilder = new TreeBuilder();
    }
    WorkspaceTree.enableCache = project.enableCache;
    workspaceTree.setDocsToDo(project.files);
    connection.console.log('starting work!');
    // Run asynchronously
    setTimeout(() => {
        glob(project.craneRoot + '/phpstubs/*/*.php', (err, fileNames) => {
            // Process the php stubs
            workspaceTree.setStubs(fileNames);
            Debug.info(`Processing ${workspaceTree.stubCount} stubs from ${project.craneRoot}/phpstubs`)
            connection.console.log(`Stub files to process: ${workspaceTree.stubCount}`);
            workspaceTree.processStub().then(data => {
                connection.console.log('stubs done!');
                connection.console.log(`Workspace files to process: ${workspaceTree.docsToDoCount}`);
                workspaceTree.processWorkspaceFiles(project.projectPath, project.treePath);
            }).catch(data => {
                connection.console.log('No stubs found!');
                connection.console.log(`Workspace files to process: ${workspaceTree.docsToDoCount}`);
                workspaceTree.processWorkspaceFiles(project.projectPath, project.treePath);
            });
        });
    }, 100);
});

var buildFromProject: RequestType<{treePath:string, enableCache:boolean}, any, any> = { method: "buildFromProject" };
connection.onRequest(buildFromProject, (data) => {
    WorkspaceTree.enableCache = data.enableCache;
    fs.readFile(data.treePath, (err, data) => {
        if (err) {
            Debug.error('Could not read cache file');
            Debug.error((util.inspect(err, false, null)));
        } else {
            Debug.info('Unzipping the file');
            var treeStream: Buffer = new Buffer(data);
            workspaceTree.loadProjectTree(treeStream).then(complete => {
                workspaceTree.notifyClientOfWorkComplete();
            });
        }
    });
});

connection.listen();
