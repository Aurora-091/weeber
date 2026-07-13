import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";

export function BranchEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const branch = (data as { branch?: string } | undefined)?.branch;

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} />
      {branch && (
        <EdgeLabelRenderer>
          <div
            className="absolute pointer-events-none bg-muted text-muted-foreground text-[10px] uppercase font-medium rounded-full px-2 py-0.5"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {branch}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
