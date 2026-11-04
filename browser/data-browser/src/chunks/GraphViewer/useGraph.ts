// @wc-ignore-file
import { Edge, Node, NodeChange, applyNodeChanges } from 'reactflow';
import { EdgeData, NodeData, applyNodeStyling } from './buildGraph';
import { useCallback, useMemo, useRef, useState } from 'react';
import Dagre from '@dagrejs/dagre';
import { useTheme } from 'styled-components';
import { dataBrowser, Resource, useValue } from '@tomic/react';

interface CustomNodePositioning {
  [key: string]: [x: number, y: number];
}

type UseNodeReturn = {
  nodes: Node<NodeData>[];
  edges: Edge<EdgeData>[];
  setGraph: (nodes: Node<NodeData>[], edges: Edge<EdgeData>[]) => void;
  handleNodeChange: (changes: NodeChange[]) => void;
  handleNodeDoubleClick: (event: React.MouseEvent, node: Node) => void;
};

const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));

const getLayoutedElements = (nodes: Node[], edges: Edge[]) => {
  g.setGraph({ rankdir: 'vertical', ranksep: 70 });

  edges.forEach(edge => g.setEdge(edge.source, edge.target));
  nodes.forEach(node => g.setNode(node.id, { width: 120, height: 100 }));

  Dagre.layout(g);

  return {
    positionedNodes: nodes.map(node => {
      const { x, y } = g.node(node.id);

      return { ...node, position: { x, y } };
    }),
    positionedEdges: edges,
  };
};

const placeNodesInSpace = (
  nodes: Node[],
  edges: Edge[],
  customPositioning: CustomNodePositioning,
): [nodes: Node[], edges: Edge[]] => {
  const { positionedNodes, positionedEdges } = getLayoutedElements(
    nodes,
    edges,
  );

  const ajustedNodes = positionedNodes.map(node => {
    if (customPositioning[node.id]) {
      const [x, y] = customPositioning[node.id];

      return { ...node, position: { x, y }, positionAbsolute: { x, y } };
    }

    return node;
  });

  return [ajustedNodes, positionedEdges];
};

export function useGraph(ontology: Resource): UseNodeReturn {
  const theme = useTheme();

  // `customNodePositioning` is a JSON property holding a plain object that maps
  // each node's subject to its `[x, y]` position. Read and write it as a native
  // object via `useValue` — NOT as a `JSON.stringify`'d string. The stringified
  // form round-tripped through `useString`/`valToString` as `"[object Object]"`
  // (an object has no useful `toString()`), which `JSON.parse` then choked on.
  const [customPositioningValue, setCustomPositioning] = useValue(
    ontology,
    dataBrowser.properties.customNodePositioning,
    { commit: true },
  );

  const customPositioning = useMemo<CustomNodePositioning>(
    () => (customPositioningValue as CustomNodePositioning | undefined) ?? {},
    [customPositioningValue],
  );

  const [nodes, setNodes] = useState<Node<NodeData>[]>([]);
  const [edges, setEdges] = useState<Edge<EdgeData>[]>([]);
  // A stop notification may omit coordinates, and several notifications can
  // arrive before React renders. Keep the last drag position per node.
  const dragPositions = useRef(new Map<string, { x: number; y: number }>());

  const setGraph = useCallback(
    (_nodes: Node<NodeData>[], _edges: Edge<EdgeData>[]) => {
      const [positionedNodes, positionedEdges] = placeNodesInSpace(
        _nodes,
        _edges,
        customPositioning,
      );
      setNodes(applyNodeStyling(positionedNodes, theme));
      setEdges(positionedEdges);
    },
    [theme, customPositioning],
  );

  const handleNodeDoubleClick = useCallback(
    async (_e: React.MouseEvent, node: Node) => {
      const newCustomPositioning = {
        ...customPositioning,
      };

      delete newCustomPositioning[node.id];

      await setCustomPositioning(newCustomPositioning);

      const [positionedNodes] = placeNodesInSpace(
        nodes,
        edges,
        newCustomPositioning,
      );

      setNodes(positionedNodes);
    },
    [customPositioning, nodes, edges, setCustomPositioning],
  );

  const handleNodeChange = useCallback(
    (changes: NodeChange[]) => {
      const nextPositioning = { ...customPositioning };
      let moved = false;

      for (const change of changes) {
        if (change.type !== 'position') continue;
        const position = change.position ?? change.positionAbsolute;

        if (change.dragging === true) {
          if (position) dragPositions.current.set(change.id, position);
        } else if (change.dragging === false) {
          const finalPosition =
            position ?? dragPositions.current.get(change.id);
          dragPositions.current.delete(change.id);

          if (
            finalPosition &&
            Number.isFinite(finalPosition.x) &&
            Number.isFinite(finalPosition.y)
          ) {
            nextPositioning[change.id] = [finalPosition.x, finalPosition.y];
            moved = true;
          }
        }
      }

      // Layout/measurement events have no dragging flag. They must neither
      // require a previous drag nor replace the user's saved positions.
      if (moved) void setCustomPositioning(nextPositioning);
      setNodes(prev => applyNodeChanges(changes, prev));
    },
    [customPositioning, setCustomPositioning],
  );

  return {
    nodes,
    edges,
    setGraph,
    handleNodeChange,
    handleNodeDoubleClick,
  };
}
