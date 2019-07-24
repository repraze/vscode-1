/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISpliceable } from 'vs/base/common/sequence';
import { Iterator, ISequence } from 'vs/base/common/iterator';
import { Event } from 'vs/base/common/event';
import { ITreeModel, ITreeNode, ITreeElement, ICollapseStateChangeEvent, ITreeModelSpliceEvent, TreeFilterResult, TreeVisibility } from 'vs/base/browser/ui/tree/tree';
import { IObjectTreeModelOptions, ObjectTreeModel, IObjectTreeModel } from 'vs/base/browser/ui/tree/objectTreeModel';

// Exported only for test reasons, do not use directly
export interface ICompressedTreeElement<T> extends ITreeElement<T> {
	readonly children?: Iterator<ICompressedTreeElement<T>> | ICompressedTreeElement<T>[];
	readonly incompressible?: boolean;
}

// Exported only for test reasons, do not use directly
export interface ICompressedTreeNode<T> {
	readonly elements: T[];
	readonly incompressible: boolean;
}

// Exported only for test reasons, do not use directly
export function compress<T>(element: ICompressedTreeElement<T>): ITreeElement<ICompressedTreeNode<T>> {
	const elements = [element.element];
	const incompressible = element.incompressible || false;

	let childrenIterator: Iterator<ITreeElement<T>>;
	let children: ITreeElement<T>[];

	while (true) {
		childrenIterator = Iterator.from(element.children);
		children = Iterator.collect(childrenIterator, 2);

		if (children.length !== 1) {
			break;
		}

		element = children[0];

		if (element.incompressible) {
			break;
		}

		elements.push(element.element);
	}

	return {
		element: { elements, incompressible },
		children: Iterator.map(Iterator.concat(Iterator.fromArray(children), childrenIterator), compress)
	};
}

function _decompress<T>(element: ITreeElement<ICompressedTreeNode<T>>, index = 0): ICompressedTreeElement<T> {
	let children: Iterator<ICompressedTreeElement<T>>;

	if (index < element.element.elements.length - 1) {
		children = Iterator.single(_decompress(element, index + 1));
	} else {
		children = Iterator.map(Iterator.from(element.children), el => _decompress(el, 0));
	}

	if (index === 0 && element.element.incompressible) {
		return { element: element.element.elements[index], children, incompressible: true };
	}

	return { element: element.element.elements[index], children };
}

// Exported only for test reasons, do not use directly
export function decompress<T>(element: ITreeElement<ICompressedTreeNode<T>>): ICompressedTreeElement<T> {
	return _decompress(element, 0);
}

function splice<T>(treeElement: ICompressedTreeElement<T>, element: T, children: Iterator<ICompressedTreeElement<T>>): ICompressedTreeElement<T> {
	if (treeElement.element === element) {
		return { element, children };
	}

	return {
		...treeElement,
		children: Iterator.map(Iterator.from(treeElement.children), e => splice(e, element, children))
	};
}

interface ICompressedObjectTreeModelOptions<T, TFilterData> extends IObjectTreeModelOptions<ICompressedTreeNode<T>, TFilterData> { }

// Exported only for test reasons, do not use directly
export class CompressedObjectTreeModel<T extends NonNullable<any>, TFilterData extends NonNullable<any> = void> implements ITreeModel<ICompressedTreeNode<T> | null, TFilterData, T | null> {

	readonly rootRef = null;

	get onDidSplice(): Event<ITreeModelSpliceEvent<ICompressedTreeNode<T> | null, TFilterData>> { return this.model.onDidSplice; }
	get onDidChangeCollapseState(): Event<ICollapseStateChangeEvent<ICompressedTreeNode<T>, TFilterData>> { return this.model.onDidChangeCollapseState; }
	get onDidChangeRenderNodeCount(): Event<ITreeNode<ICompressedTreeNode<T>, TFilterData>> { return this.model.onDidChangeRenderNodeCount; }

	private model: ObjectTreeModel<ICompressedTreeNode<T>, TFilterData>;
	private nodes = new Map<T | null, ICompressedTreeNode<T>>();

	get size(): number { return this.nodes.size; }

	constructor(list: ISpliceable<ITreeNode<ICompressedTreeNode<T>, TFilterData>>, options: ICompressedObjectTreeModelOptions<T, TFilterData> = {}) {
		this.model = new ObjectTreeModel(list, options);
	}

	setChildren(
		element: T | null,
		children: ISequence<ICompressedTreeElement<T>> | undefined,
		onDidCreateNode?: (node: ITreeNode<ICompressedTreeNode<T>, TFilterData>) => void,
		onDidDeleteNode?: (node: ITreeNode<ICompressedTreeNode<T>, TFilterData>) => void
	): void {
		const insertedElements = new Set<T | null>();
		const _onDidCreateNode = (node: ITreeNode<ICompressedTreeNode<T>, TFilterData>) => {
			for (const element of node.element.elements) {
				insertedElements.add(element);
				this.nodes.set(element, node.element);
			}

			// if (this.identityProvider) {
			// 	const id = this.identityProvider.getId(node.element).toString();
			// 	insertedElementIds.add(id);
			// 	this.nodesByIdentity.set(id, node);
			// }

			if (onDidCreateNode) {
				onDidCreateNode(node);
			}
		};

		const _onDidDeleteNode = (node: ITreeNode<ICompressedTreeNode<T>, TFilterData>) => {
			for (const element of node.element.elements) {
				if (!insertedElements.has(element)) {
					this.nodes.delete(element);
				}
			}

			// if (this.identityProvider) {
			// 	const id = this.identityProvider.getId(node.element).toString();
			// 	if (!insertedElementIds.has(id)) {
			// 		this.nodesByIdentity.delete(id);
			// 	}
			// }

			if (onDidDeleteNode) {
				onDidDeleteNode(node);
			}
		};

		if (element === null) {
			const compressedChildren = Iterator.map(Iterator.from(children), compress);
			this.model.setChildren(null, compressedChildren, _onDidCreateNode, _onDidDeleteNode);
			return;
		}

		const compressedNode = this.nodes.get(element);
		const node = this.model.getNode(compressedNode) as ITreeNode<ICompressedTreeNode<T>, TFilterData>;
		const parent = node.parent!;

		const decompressedElement = decompress(node);
		const splicedElement = splice(decompressedElement, element, Iterator.from(children));
		const recompressedElement = compress(splicedElement);

		const parentChildren = parent.children
			.map(child => child === node ? recompressedElement : child);

		this.model.setChildren(parent.element, parentChildren, _onDidCreateNode, _onDidDeleteNode);
	}

	getListIndex(location: T | null): number {
		const node = this.getCompressedNode(location);
		return this.model.getListIndex(node);
	}

	getListRenderCount(location: T | null): number {
		const node = this.getCompressedNode(location);
		return this.model.getListRenderCount(node);
	}

	getNode(location?: T | null | undefined): ITreeNode<ICompressedTreeNode<T> | null, TFilterData> {
		if (typeof location === 'undefined') {
			return this.model.getNode();
		}

		const node = this.getCompressedNode(location);
		return this.model.getNode(node);
	}

	// TODO: review this
	getNodeLocation(node: ITreeNode<ICompressedTreeNode<T>, TFilterData>): T | null {
		const compressedNode = this.model.getNodeLocation(node);

		if (compressedNode === null) {
			return null;
		}

		return compressedNode.elements[compressedNode.elements.length - 1];
	}

	// TODO: review this
	getParentNodeLocation(location: T | null): T | null {
		const compressedNode = this.getCompressedNode(location);
		const parentNode = this.model.getParentNodeLocation(compressedNode);

		if (parentNode === null) {
			return null;
		}

		return parentNode.elements[parentNode.elements.length - 1];
	}

	getParentElement(location: T | null): ICompressedTreeNode<T> | null {
		const compressedNode = this.getCompressedNode(location);
		return this.model.getParentElement(compressedNode);
	}

	getFirstElementChild(location: T | null): ICompressedTreeNode<T> | null | undefined {
		const compressedNode = this.getCompressedNode(location);
		return this.model.getFirstElementChild(compressedNode);
	}

	getLastElementAncestor(location?: T | null | undefined): ICompressedTreeNode<T> | null | undefined {
		const compressedNode = typeof location === 'undefined' ? undefined : this.getCompressedNode(location);
		return this.model.getLastElementAncestor(compressedNode);
	}

	isCollapsible(location: T | null): boolean {
		const compressedNode = this.getCompressedNode(location);
		return this.model.isCollapsible(compressedNode);
	}

	isCollapsed(location: T | null): boolean {
		const compressedNode = this.getCompressedNode(location);
		return this.model.isCollapsed(compressedNode);
	}

	setCollapsed(location: T | null, collapsed?: boolean | undefined, recursive?: boolean | undefined): boolean {
		const compressedNode = this.getCompressedNode(location);
		return this.model.setCollapsed(compressedNode, collapsed, recursive);
	}

	expandTo(location: T | null): void {
		const compressedNode = this.getCompressedNode(location);
		this.model.expandTo(compressedNode);
	}

	rerender(location: T | null): void {
		const compressedNode = this.getCompressedNode(location);
		this.model.rerender(compressedNode);
	}

	refilter(): void {
		this.model.refilter();
	}

	resort(location: T | null = null, recursive = true): void {
		const compressedNode = this.getCompressedNode(location);
		this.model.resort(compressedNode, recursive);
	}

	getCompressedNode(element: T | null): ICompressedTreeNode<T> | null {
		if (element === null) {
			return null;
		}

		const node = this.nodes.get(element);

		if (!node) {
			throw new Error(`Tree element not found: ${element}`);
		}

		return node;
	}
}

// Compressible Object Tree

export type ElementMapper<T> = (elements: T[]) => T;
export type CompressedNodeMapper<T> = (node: ICompressedTreeNode<T>) => T;
export type NodeMapper<T, TFilterData> = (node: ITreeNode<ICompressedTreeNode<T> | null, TFilterData>) => ITreeNode<T | null, TFilterData>;

export const DefaultElementMapper: ElementMapper<any> = elements => elements[elements.length - 1];

function mapNode<T, TFilterData>(compressedNodeMapper: CompressedNodeMapper<T>, node: ITreeNode<ICompressedTreeNode<T> | null, TFilterData>): ITreeNode<T | null, TFilterData> {
	return {
		...node,
		element: node.element === null ? null : compressedNodeMapper(node.element),
		children: node.children.map(child => mapNode(compressedNodeMapper, child)),
		parent: typeof node.parent === 'undefined' ? node.parent : mapNode(compressedNodeMapper, node.parent)
	};
}

function mapList<T, TFilterData>(nodeMapper: NodeMapper<T, TFilterData>, list: ISpliceable<ITreeNode<T, TFilterData>>): ISpliceable<ITreeNode<ICompressedTreeNode<T>, TFilterData>> {
	return {
		splice(start: number, deleteCount: number, toInsert: ITreeNode<ICompressedTreeNode<T>, TFilterData>[]): void {
			list.splice(start, deleteCount, toInsert.map(nodeMapper) as ITreeNode<T, TFilterData>[]);
		}
	};
}

function mapOptions<T, TFilterData>(compressedNodeMapper: CompressedNodeMapper<T>, options: ICompressibleObjectTreeModelOptions<T, TFilterData>): ICompressedObjectTreeModelOptions<T, TFilterData> {
	return {
		...options,
		sorter: options.sorter && {
			compare(element: ICompressedTreeNode<T>, otherElement: ICompressedTreeNode<T>): number {
				return options.sorter!.compare(compressedNodeMapper(element), compressedNodeMapper(otherElement));
			}
		},
		identityProvider: options.identityProvider && {
			getId(element: ICompressedTreeNode<T>): { toString(): string; } {
				return options.identityProvider!.getId(compressedNodeMapper(element));
			}
		},
		filter: options.filter && {
			filter(element: ICompressedTreeNode<T>, parentVisibility: TreeVisibility): TreeFilterResult<TFilterData> {
				return options.filter!.filter(compressedNodeMapper(element), parentVisibility);
			}
		}
	};
}

export interface ICompressibleObjectTreeModelOptions<T, TFilterData> extends IObjectTreeModelOptions<T, TFilterData> {
	readonly elementMapper?: ElementMapper<T>;
}

export class CompressibleObjectTreeModel<T extends NonNullable<any>, TFilterData extends NonNullable<any> = void> implements IObjectTreeModel<T, TFilterData> {

	readonly rootRef = null;

	get onDidSplice(): Event<ITreeModelSpliceEvent<T | null, TFilterData>> {
		return Event.map(this.model.onDidSplice, ({ insertedNodes, deletedNodes }) => ({
			insertedNodes: insertedNodes.map(this.nodeMapper),
			deletedNodes: deletedNodes.map(this.nodeMapper),
		}));
	}

	get onDidChangeCollapseState(): Event<ICollapseStateChangeEvent<T | null, TFilterData>> {
		return Event.map(this.model.onDidChangeCollapseState, ({ node, deep }) => ({
			node: this.nodeMapper(node),
			deep
		}));
	}

	get onDidChangeRenderNodeCount(): Event<ITreeNode<T | null, TFilterData>> {
		return Event.map(this.model.onDidChangeRenderNodeCount, this.nodeMapper);
	}

	private elementMapper: ElementMapper<T>;
	private nodeMapper: NodeMapper<T, TFilterData>;
	private model: CompressedObjectTreeModel<T, TFilterData>;

	constructor(
		list: ISpliceable<ITreeNode<T, TFilterData>>,
		options: ICompressibleObjectTreeModelOptions<T, TFilterData> = {}
	) {
		this.elementMapper = options.elementMapper || DefaultElementMapper;
		const compressedNodeMapper: CompressedNodeMapper<T> = node => this.elementMapper(node.elements);
		this.nodeMapper = node => mapNode(compressedNodeMapper, node);

		this.model = new CompressedObjectTreeModel(mapList(this.nodeMapper, list), mapOptions(compressedNodeMapper, options));
	}

	setChildren(element: T | null, children?: ISequence<ITreeElement<T>>): void {
		this.model.setChildren(element, children);
	}

	getListIndex(location: T | null): number {
		return this.model.getListIndex(location);
	}

	getListRenderCount(location: T | null): number {
		return this.model.getListRenderCount(location);
	}

	getNode(location?: T | null | undefined): ITreeNode<T | null, any> {
		return this.nodeMapper(this.model.getNode(location));
	}

	getNodeLocation(node: ITreeNode<T | null, any>): T | null {
		return node.element;
	}

	getParentNodeLocation(location: T | null): T | null {
		return this.model.getParentNodeLocation(location);
	}

	getParentElement(location: T | null): T | null {
		const result = this.model.getParentElement(location);

		if (result === null) {
			return result;
		}

		return this.elementMapper(result.elements);
	}

	getFirstElementChild(location: T | null): T | null | undefined {
		const result = this.model.getFirstElementChild(location);

		if (result === null || typeof result === 'undefined') {
			return result;
		}

		return this.elementMapper(result.elements);
	}

	getLastElementAncestor(location?: T | null | undefined): T | null | undefined {
		const result = this.model.getLastElementAncestor(location);

		if (result === null || typeof result === 'undefined') {
			return result;
		}

		return this.elementMapper(result.elements);
	}

	isCollapsible(location: T | null): boolean {
		return this.model.isCollapsible(location);
	}

	isCollapsed(location: T | null): boolean {
		return this.model.isCollapsed(location);
	}

	setCollapsed(location: T | null, collapsed?: boolean | undefined, recursive?: boolean | undefined): boolean {
		return this.model.setCollapsed(location, collapsed, recursive);
	}

	expandTo(location: T | null): void {
		return this.model.expandTo(location);
	}

	rerender(location: T | null): void {
		return this.model.rerender(location);
	}

	refilter(): void {
		return this.model.refilter();
	}

	resort(element: T | null = null, recursive = true): void {
		return this.model.resort(element, recursive);
	}

	getCompressedTreeNode(element: T): ITreeNode<ICompressedTreeNode<T>, TFilterData> {
		return this.model.getNode(element) as ITreeNode<ICompressedTreeNode<T>, TFilterData>;
	}
}