#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""STEP → S3DM 三角网格 + 边线框（单位 mm），供 DSH 3D 预览插件的 Host 半边调用。

独立实现：只依赖 OCP（OCCT 的 python 绑定）与 numpy（可选加速），
不 import、不修改 sw-mcp 仓库里的任何文件；思路与其 worker.py 一致但代码是独立写的。

用法：
    python step_mesh.py --in <step> --out <s3dm> --deflection 0.2 [--source-path <原始路径>]

退出码：
    0  成功（stdout 一行 JSON 摘要）
    2  参数错误
    3  OCP 不可用
    4  STEP 读取或三角化失败
    5  S3DM 写盘失败

输出约定：
    - stdout 最后一行 JSON 是给 Node 解析的摘要/错误体，其它行都不以 '{' 开头。
    - stderr 是人看的诊断（Node 侧只回传尾部 800 字符）。
"""

import argparse
import json
import math
import os
import shutil
import struct
import sys
import tempfile
import time
import traceback

MAX_TRIANGLES = 300000      # 三角形上限默认值（可用 --max-triangles 覆盖）：超过先加大挠度重试一次，仍超则截断
MAX_EDGE_POINTS = 400000    # 边折线总点数上限：超过整体步长降采样
DEFAULT_DEFLECTION = 0.2
ANGULAR_DEFLECTION = 0.5    # 弧度

S3DM_VERSION = 2            # v2：新增可选 faceEdge buffer + faceEdgeCount/maxTriangles 头字段

OCP_ERROR = None
try:
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepTools import BRepTools
    from OCP.Bnd import Bnd_Box
    from OCP.GCPnts import GCPnts_QuasiUniformAbscissa
    from OCP.GeomAbs import (
        GeomAbs_Circle,
        GeomAbs_Cone,
        GeomAbs_Cylinder,
        GeomAbs_Line,
        GeomAbs_Plane,
        GeomAbs_Sphere,
        GeomAbs_Torus,
    )
    from OCP.GProp import GProp_GProps
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_Reader
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopExp import TopExp, TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    HAVE_OCP = True
except Exception as error:  # pragma: no cover - 只在缺依赖时走到
    HAVE_OCP = False
    OCP_ERROR = "%s: %s" % (type(error).__name__, error)

try:
    import numpy as _np
except Exception:  # pragma: no cover - numpy 只是加速手段
    _np = None


class MeshError(RuntimeError):
    def __init__(self, code, message, exit_code=4):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


# --------------------------------------------------------------------------- 小工具

def rnd(value, digits=6):
    try:
        number = float(value)
    except Exception:
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return round(number, digits)


def align4(value):
    return (int(value) + 3) & ~3


def pack_f32(values):
    if _np is not None:
        return _np.asarray(values, dtype="<f4").tobytes()
    return struct.pack("<%df" % len(values), *values)


def pack_u32(values):
    if _np is not None:
        return _np.asarray(values, dtype="<u4").tobytes()
    return struct.pack("<%dI" % len(values), *values)


def tail(message, limit=2000):
    text = str(message)
    return text if len(text) <= limit else text[-limit:]


# --------------------------------------------------------------------------- S3DM 写

def write_s3dm(out_path, header, buffers):
    """按 S3DM 约定写文件：魔数 + u32 头长度 + header JSON + 4 字节对齐的 buffer 数据区。

    buffers: [{'name','type','components','count','data'(bytes)}]
    先写 .tmp 再 os.replace，避免 Node 侧读到半个文件。
    """
    descriptors = []
    chunks = []
    cursor = 0
    for entry in buffers:
        data = entry["data"]
        descriptors.append({
            "name": entry["name"],
            "type": entry["type"],
            "components": int(entry["components"]),
            "count": int(entry["count"]),
            "offset": cursor,
        })
        chunks.append((cursor, data))
        cursor += len(data)
        cursor += (4 - cursor % 4) % 4

    final_header = dict(header)
    final_header["buffers"] = descriptors
    json_bytes = json.dumps(final_header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    # 客户端 parseS3DM 用 base = 8 + headerJsonLength 当数据区起点（不做 align4），
    # 并要求每个 buffer 绝对偏移 % 4 == 0。用空格把 JSON 补到 4 字节对齐，两边算法就重合。
    padding = (4 - ((8 + len(json_bytes)) % 4)) % 4
    if padding:
        json_bytes += b" " * padding
    section_start = 8 + len(json_bytes)
    out = bytearray(section_start + cursor)
    out[0:4] = b"S3DM"
    struct.pack_into("<I", out, 4, len(json_bytes))
    out[8:8 + len(json_bytes)] = json_bytes
    for offset, data in chunks:
        start = section_start + offset
        out[start:start + len(data)] = data

    temporary = out_path + ".tmp"
    with open(temporary, "wb") as handle:
        handle.write(out)
    os.replace(temporary, out_path)
    return len(out)


# --------------------------------------------------------------------------- OCCT 适配

def shape_map_types():
    """OCP 8 把模板实例放在 OCP.collections，OCP 7 放在 OCP.TopTools。"""
    try:
        from OCP.collections import (
            IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher as edge_faces_map,
            IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as shape_map,
        )
        return shape_map, edge_faces_map
    except Exception:
        from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape
        return TopTools_IndexedMapOfShape, TopTools_IndexedDataMapOfShapeListOfShape


def use_mm_units():
    """STEP 可能按米/英寸声明长度单位；OCCT 靠 xstep.cascade.unit 换算到 mm。"""
    try:
        Interface_Static.SetCVal_s("xstep.cascade.unit", "MM")
    except Exception:
        pass


def read_step(path):
    """读 STEP；直接打开失败时把文件复制成 ASCII 临时名再试一次（Windows 非 ASCII 路径兜底）。"""
    reader = STEPControl_Reader()
    status = reader.ReadFile(path)
    shape = None
    if status == IFSelect_RetDone:
        try:
            reader.TransferRoots()
            shape = reader.OneShape()
        except Exception:
            shape = None
        if shape is not None and not shape.IsNull():
            return shape

    temporary_dir = tempfile.mkdtemp(prefix="sw3d-step-")
    fallback = os.path.join(temporary_dir, "input.step")
    try:
        shutil.copyfile(path, fallback)
        reader = STEPControl_Reader()
        if reader.ReadFile(fallback) != IFSelect_RetDone:
            raise MeshError("STEP_READ_FAILED", "STEP 读取失败：%s" % path)
        reader.TransferRoots()
        shape = reader.OneShape()
        if shape is None or shape.IsNull():
            raise MeshError("STEP_EMPTY", "STEP 里没有可用的形体：%s" % path)
        return shape
    finally:
        shutil.rmtree(temporary_dir, ignore_errors=True)


def shape_bbox(shape):
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    low, high = box.CornerMin(), box.CornerMax()
    bbox = [rnd(low.X()), rnd(low.Y()), rnd(low.Z()), rnd(high.X()), rnd(high.Y()), rnd(high.Z())]
    center = [(bbox[0] + bbox[3]) / 2.0, (bbox[1] + bbox[4]) / 2.0, (bbox[2] + bbox[5]) / 2.0]
    return bbox, center


def triangulate(shape, deflection, clean=False):
    """就地三角化。clean=True 先丢掉已有网格 —— BRepMesh 是增量的，否则加大挠度没效果。"""
    if clean:
        try:
            BRepTools.Clean_s(shape, True)
        except Exception:
            pass
    try:
        mesh = BRepMesh_IncrementalMesh(shape, deflection, False, ANGULAR_DEFLECTION, True)
        return bool(mesh.IsDone())
    except Exception:
        return False


def count_triangles(shape):
    total = 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face(explorer.Current())
        location = TopLoc_Location()
        try:
            triangulation = BRep_Tool.Triangulation_s(face, location)
            if triangulation is not None:
                total += int(triangulation.NbTriangles())
        except Exception:
            pass
        explorer.Next()
    return total


FACE_KINDS = {
    int(GeomAbs_Plane): "plane",
    int(GeomAbs_Cylinder): "cylinder",
    int(GeomAbs_Cone): "cone",
    int(GeomAbs_Sphere): "sphere",
    int(GeomAbs_Torus): "torus",
}


def face_entry(index, face):
    """faces[] 的一条：类型 + 面积 + 可画标记的法向/点 + 半径（有就填）。"""
    area = 0.0
    props = GProp_GProps()
    try:
        BRepGProp.SurfaceProperties_s(face, props)
        area = float(props.Mass())
    except Exception:
        area = 0.0
    entry = {
        "index": index,
        "kind": "other",
        "areaMm2": rnd(area, 4),
        "normal": [0.0, 0.0, 0.0],
        "point": [0.0, 0.0, 0.0],
        "radiusMm": None,
    }
    try:
        adaptor = BRepAdaptor_Surface(face)
        kind = int(adaptor.GetType())
        entry["kind"] = FACE_KINDS.get(kind, "other")
        if kind == int(GeomAbs_Plane):
            plane = adaptor.Plane()
            direction = plane.Axis().Direction()
            origin = plane.Location()
            entry["normal"] = [rnd(direction.X()), rnd(direction.Y()), rnd(direction.Z())]
            entry["point"] = [rnd(origin.X()), rnd(origin.Y()), rnd(origin.Z())]
        elif kind == int(GeomAbs_Cylinder):
            cylinder = adaptor.Cylinder()
            axis = cylinder.Axis()
            entry["normal"] = [rnd(axis.Direction().X()), rnd(axis.Direction().Y()), rnd(axis.Direction().Z())]
            entry["point"] = [rnd(axis.Location().X()), rnd(axis.Location().Y()), rnd(axis.Location().Z())]
            entry["radiusMm"] = rnd(cylinder.Radius())
        elif kind == int(GeomAbs_Cone):
            cone = adaptor.Cone()
            axis = cone.Axis()
            entry["normal"] = [rnd(axis.Direction().X()), rnd(axis.Direction().Y()), rnd(axis.Direction().Z())]
            entry["point"] = [rnd(axis.Location().X()), rnd(axis.Location().Y()), rnd(axis.Location().Z())]
            entry["radiusMm"] = rnd(cone.RefRadius())
        elif kind == int(GeomAbs_Sphere):
            sphere = adaptor.Sphere()
            center = sphere.Location()
            entry["point"] = [rnd(center.X()), rnd(center.Y()), rnd(center.Z())]
            entry["radiusMm"] = rnd(sphere.Radius())
        elif kind == int(GeomAbs_Torus):
            torus = adaptor.Torus()
            center = torus.Location()
            entry["point"] = [rnd(center.X()), rnd(center.Y()), rnd(center.Z())]
            entry["radiusMm"] = rnd(torus.MajorRadius())
    except Exception:
        pass
    return entry


def triangle_cross(points):
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = points
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    return (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)


def edge_polyline(edge, curve, length, deflection):
    """沿边取折线：直线 2 点；曲线按长度决定 8~96 点，失败退回参数均匀采样。"""
    first, last = curve.FirstParameter(), curve.LastParameter()
    kind = int(curve.GetType())
    if kind == int(GeomAbs_Line):
        samples = 2
    elif kind == int(GeomAbs_Circle):
        samples = max(12, min(96, int(math.ceil(length / max(deflection * 1.5, 0.05)))))
    else:
        samples = max(8, min(96, int(math.ceil(length / max(deflection * 1.5, 0.05)))))
    samples = max(2, samples)

    points = []
    try:
        sampler = GCPnts_QuasiUniformAbscissa(curve, samples)
        if sampler.IsDone() and sampler.NbPoints() >= 2:
            for index in range(1, sampler.NbPoints() + 1):
                point = curve.Value(sampler.Parameter(index))
                points.append((point.X(), point.Y(), point.Z()))
    except Exception:
        points = []
    if len(points) < 2:
        points = []
        span = last - first
        if abs(span) < 1e-12:
            span = 1e-6
        for index in range(samples):
            point = curve.Value(first + span * index / float(max(samples - 1, 1)))
            points.append((point.X(), point.Y(), point.Z()))
    if len(points) < 2:
        point = curve.Value(first)
        points = [(point.X(), point.Y(), point.Z()), (point.X(), point.Y(), point.Z())]
    return points


# --------------------------------------------------------------------------- 主流程

def build_mesh(in_path, out_path, deflection, source_path=None, max_triangles=None):
    started = time.time()
    if not HAVE_OCP:
        raise MeshError("OCP_MISSING", "缺少 OCP（OCCT python 绑定）：%s" % OCP_ERROR, 3)
    if not os.path.isfile(in_path):
        raise MeshError("NOT_FOUND", "STEP 文件不存在：%s" % in_path, 2)

    try:
        triangle_limit = int(max_triangles) if max_triangles else MAX_TRIANGLES
    except Exception:
        triangle_limit = MAX_TRIANGLES
    triangle_limit = max(2000, min(5000000, triangle_limit))

    use_mm_units()
    shape = read_step(in_path)
    bbox, center = shape_bbox(shape)

    warnings = []
    truncated_triangles = False
    truncated_edges = False
    retried = False

    triangulate(shape, deflection)
    triangle_total = count_triangles(shape)
    effective_deflection = deflection
    if triangle_total > triangle_limit:
        retry_deflection = min(50.0, deflection * math.sqrt(triangle_total / float(triangle_limit)) * 1.05)
        if triangulate(shape, retry_deflection, clean=True):
            retried_total = count_triangles(shape)
            if retried_total < triangle_total:
                effective_deflection = retry_deflection
                triangle_total = retried_total
                retried = True
                warnings.append(
                    "三角形数 %d 超过上限 %d，挠度从 %.4f 放大到 %.4f 后重算"
                    % (triangle_total, triangle_limit, deflection, effective_deflection)
                )

    ShapeMap, EdgeFacesMap = shape_map_types()
    face_map = ShapeMap()
    edge_map = ShapeMap()
    TopExp.MapShapes_s(shape, TopAbs_FACE, face_map)
    TopExp.MapShapes_s(shape, TopAbs_EDGE, edge_map)
    edge_faces = EdgeFacesMap()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, edge_faces)

    positions = []
    normals = []
    indices = []
    face_of_triangle = []
    faces = []
    flip_votes = 0.0

    face_count = face_map.Extent()
    for face_index in range(face_count):
        face = TopoDS.Face(face_map.FindKey(face_index + 1))
        entry = face_entry(face_index, face)
        location = TopLoc_Location()
        triangulation = None
        try:
            triangulation = BRep_Tool.Triangulation_s(face, location)
        except Exception:
            triangulation = None
        if triangulation is None:
            faces.append(entry)
            continue

        try:
            node_count = int(triangulation.NbNodes())
            triangle_count = int(triangulation.NbTriangles())
        except Exception:
            node_count, triangle_count = 0, 0
        if node_count <= 0 or triangle_count <= 0:
            faces.append(entry)
            continue
        if len(indices) // 3 >= triangle_limit:
            truncated_triangles = True
            faces.append(entry)
            continue

        transform = None if location.IsIdentity() else location.Transformation()
        nodes = []
        for node_index in range(1, node_count + 1):
            point = triangulation.Node(node_index)
            if transform is not None:
                point = point.Transformed(transform)
            nodes.append((point.X(), point.Y(), point.Z()))
        reversed_face = face.Orientation() == TopAbs_REVERSED

        accumulated = [0.0, 0.0, 0.0]
        local_area = 0.0
        for triangle_index in range(1, triangle_count + 1):
            if len(indices) // 3 >= triangle_limit:
                truncated_triangles = True
                break
            try:
                ia, ib, ic = triangulation.Triangle(triangle_index).Get()
            except Exception:
                continue
            points = [nodes[ia - 1], nodes[ib - 1], nodes[ic - 1]]
            if reversed_face:
                points = [points[0], points[2], points[1]]
            cross = triangle_cross(points)
            length = math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2)
            area = length / 2.0
            if length > 1e-12:
                unit = (cross[0] / length, cross[1] / length, cross[2] / length)
            else:
                unit = (0.0, 0.0, 0.0)
            accumulated[0] += cross[0]
            accumulated[1] += cross[1]
            accumulated[2] += cross[2]
            local_area += area
            base = len(positions) // 3
            for point in points:
                positions.extend((rnd(point[0], 5), rnd(point[1], 5), rnd(point[2], 5)))
                normals.extend((rnd(unit[0], 5), rnd(unit[1], 5), rnd(unit[2], 5)))
            indices.extend((base, base + 1, base + 2))
            face_of_triangle.append(face_index)

        magnitude = math.sqrt(accumulated[0] ** 2 + accumulated[1] ** 2 + accumulated[2] ** 2)
        if magnitude > 0.0:
            entry["normal"] = [
                rnd(accumulated[0] / magnitude, 6),
                rnd(accumulated[1] / magnitude, 6),
                rnd(accumulated[2] / magnitude, 6),
            ]
        if local_area > 0.0:
            centroid = [0.0, 0.0, 0.0]
            for point in nodes:
                centroid[0] += point[0]
                centroid[1] += point[1]
                centroid[2] += point[2]
            count = len(nodes)
            centroid = [centroid[0] / count, centroid[1] / count, centroid[2] / count]
            flip_votes += local_area * (
                (centroid[0] - center[0]) * entry["normal"][0]
                + (centroid[1] - center[1]) * entry["normal"][1]
                + (centroid[2] - center[2]) * entry["normal"][2]
            )
        faces.append(entry)

    # 整块实体的朝向自检：面积加权点积为负说明所有面都朝内，统一翻面。
    if flip_votes < 0.0:
        warnings.append("面法向整体朝内（面积加权点积为负），已统一翻转")
        for index in range(0, len(normals), 3):
            normals[index] = -normals[index]
            normals[index + 1] = -normals[index + 1]
            normals[index + 2] = -normals[index + 2]
        for index in range(0, len(indices), 3):
            indices[index + 1], indices[index + 2] = indices[index + 2], indices[index + 1]
        for entry in faces:
            entry["normal"] = [-value for value in entry["normal"]]

    # ------------------------------------------------------------------ 边线框
    edge_positions = []
    edge_segments = []
    edges = []
    edge_count = edge_map.Extent()
    for edge_index in range(edge_count):
        edge = TopoDS.Edge(edge_map.FindKey(edge_index + 1))
        if edge.IsNull():
            continue
        try:
            if BRep_Tool.Degenerated_s(edge):
                continue
        except Exception:
            pass
        try:
            curve = BRepAdaptor_Curve(edge)
        except Exception:
            continue
        length = 0.0
        try:
            properties = GProp_GProps()
            BRepGProp.LinearProperties_s(edge, properties)
            length = float(properties.Mass())
        except Exception:
            length = 0.0
        try:
            points = edge_polyline(edge, curve, length, effective_deflection)
        except Exception:
            continue
        if len(points) < 2:
            continue
        start_index = len(edge_positions) // 3
        for point in points:
            edge_positions.extend((rnd(point[0], 5), rnd(point[1], 5), rnd(point[2], 5)))
        for offset in range(len(points) - 1):
            edge_segments.extend((start_index + offset, start_index + offset + 1))

        is_circle = False
        radius = None
        try:
            is_circle = int(curve.GetType()) == int(GeomAbs_Circle)
            if is_circle:
                radius = rnd(curve.Circle().Radius())
        except Exception:
            is_circle, radius = False, None

        adjacent = []
        try:
            for ancestor in edge_faces.FindFromKey(edge):
                face_index = int(face_map.FindIndex(ancestor)) - 1
                if face_index >= 0 and face_index not in adjacent:
                    adjacent.append(face_index)
        except Exception:
            adjacent = []

        middle = points[len(points) // 2]
        edges.append({
            "index": len(edges),
            "isCircle": bool(is_circle),
            "radiusMm": radius,
            "lengthMm": rnd(length),
            "start": [rnd(points[0][0], 5), rnd(points[0][1], 5), rnd(points[0][2], 5)],
            "end": [rnd(points[-1][0], 5), rnd(points[-1][1], 5), rnd(points[-1][2], 5)],
            "mid": [rnd(middle[0], 5), rnd(middle[1], 5), rnd(middle[2], 5)],
            "faces": adjacent[:2],
            "polylineStart": start_index,
            "polylineCount": len(points),
        })

    # ------------------------------------------------------------------ 面↔边 关联（S3DM v2 可选 buffer）
    # [faceIndex, edgeIndex] 成对展开；客户端拿不到这个 buffer 时可以从 edges[].faces 反推，所以是可选字段。
    face_edge = []
    for entry in edges:
        for face_index in entry["faces"]:
            if isinstance(face_index, int) and 0 <= face_index < len(faces):
                face_edge.extend((face_index, entry["index"]))

    total_edge_points = len(edge_positions) // 3
    if total_edge_points > MAX_EDGE_POINTS:
        truncated_edges = True
        stride = int(math.ceil(total_edge_points / float(MAX_EDGE_POINTS)))
        new_positions = []
        new_segments = []
        for entry in edges:
            start = entry["polylineStart"]
            count = entry["polylineCount"]
            points = []
            for offset in range(0, count):
                if offset % stride == 0 or offset == count - 1:
                    points.append((start + offset) * 3)
            if len(points) < 2:
                points = [start * 3, (start + count - 1) * 3]
            new_start = len(new_positions) // 3
            for flat_index in points:
                new_positions.extend(edge_positions[flat_index:flat_index + 3])
            for offset in range(len(points) - 1):
                new_segments.extend((new_start + offset, new_start + offset + 1))
            entry["polylineStart"] = new_start
            entry["polylineCount"] = len(points)
            entry["mid"] = [
                rnd(new_positions[(new_start + len(points) // 2) * 3], 5),
                rnd(new_positions[(new_start + len(points) // 2) * 3 + 1], 5),
                rnd(new_positions[(new_start + len(points) // 2) * 3 + 2], 5),
            ]
        edge_positions = new_positions
        edge_segments = new_segments
        warnings.append("边折线总点数超上限 %d，按步长 %d 降采样" % (MAX_EDGE_POINTS, stride))

    # ------------------------------------------------------------------ 单位自检
    sizes = [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]]
    if max(sizes) > 20000.0:
        warnings.append("包围盒最大边 %.1f mm，疑似 STEP 单位不是 mm（可能是米制误读）" % max(sizes))
    if 0.0 < max(sizes) < 0.5:
        warnings.append("包围盒最大边只有 %.3f mm，疑似 STEP 单位不是 mm（可能被当成米）" % max(sizes))
    if len(indices) == 0:
        warnings.append("三角化没有产出三角形：形体可能只有线框/曲面但无实体")

    vertex_count = len(positions) // 3
    triangle_count = len(indices) // 3
    source_bytes = 0
    source_mtime = 0
    try:
        source_stat = os.stat(source_path or in_path)
        source_bytes = int(source_stat.st_size)
        source_mtime = int(round(source_stat.st_mtime * 1000))
    except Exception:
        pass

    header = {
        "version": S3DM_VERSION,
        "units": "mm",
        "format": "step",
        "source": {
            "path": source_path or in_path,
            "bytes": source_bytes,
            "mtimeMs": source_mtime,
        },
        "bbox": bbox,
        "vertexCount": vertex_count,
        "triangleCount": triangle_count,
        "faceCount": len(faces),
        "edgeCount": len(edges),
        "faceEdgeCount": len(face_edge) // 2,
        "faces": faces,
        "edges": edges,
        "warnings": warnings,
        "deflectionMm": rnd(effective_deflection, 4),
        "maxTriangles": triangle_limit,
        "precision": {
            "deflectionMm": rnd(effective_deflection, 4),
            "maxTriangles": triangle_limit,
        },
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "retried": retried,
    }
    buffers = [
        {"name": "position", "type": "f32", "components": 3, "count": vertex_count, "data": pack_f32(positions)},
        {"name": "normal", "type": "f32", "components": 3, "count": vertex_count, "data": pack_f32(normals)},
        {"name": "index", "type": "u32", "components": 3, "count": triangle_count, "data": pack_u32(indices)},
        {
            "name": "faceOfTriangle",
            "type": "u32",
            "components": 1,
            "count": triangle_count,
            "data": pack_u32(face_of_triangle),
        },
        {
            "name": "edgePosition",
            "type": "f32",
            "components": 3,
            "count": len(edge_positions) // 3,
            "data": pack_f32(edge_positions),
        },
        {
            "name": "edgeSegment",
            "type": "u32",
            "components": 2,
            "count": len(edge_segments) // 2,
            "data": pack_u32(edge_segments),
        },
        {
            "name": "faceEdge",
            "type": "u32",
            "components": 2,
            "count": len(face_edge) // 2,
            "data": pack_u32(face_edge),
        },
    ]
    written = write_s3dm(out_path, header, buffers)

    elapsed = time.time() - started
    if truncated_triangles:
        warnings.append("三角形数已达上限 %d，多余部分被截断" % triangle_limit)
    return {
        "ok": True,
        "path": source_path or in_path,
        "out": out_path,
        "bytes": written,
        "seconds": round(elapsed, 3),
        "bbox": bbox,
        "sizeMm": [rnd(value, 4) for value in sizes],
        "vertexCount": vertex_count,
        "triangleCount": triangle_count,
        "faceCount": len(faces),
        "edgeCount": len(edges),
        "faceEdgeCount": len(face_edge) // 2,
        "edgePointCount": len(edge_positions) // 3,
        "truncated": {"triangles": truncated_triangles, "edges": truncated_edges},
        "deflectionMm": rnd(effective_deflection, 4),
        "maxTriangles": triangle_limit,
        "retried": retried,
        "warnings": warnings,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="STEP → S3DM（mm）")
    parser.add_argument("--in", dest="input", required=True, help="输入 STEP 路径")
    parser.add_argument("--out", dest="output", required=True, help="输出 S3DM 路径")
    parser.add_argument("--deflection", dest="deflection", type=float, default=DEFAULT_DEFLECTION)
    parser.add_argument("--max-triangles", dest="max_triangles", type=int, default=MAX_TRIANGLES,
                        help="三角形上限（精度档）；超出会先加大挠度重算，仍超则截断")
    parser.add_argument("--source-path", dest="source_path", default=None, help="写进 header.source.path 的原始路径")
    args = parser.parse_args(argv)

    deflection = args.deflection if args.deflection and args.deflection > 0 else DEFAULT_DEFLECTION
    try:
        summary = build_mesh(args.input, args.output, deflection, args.source_path, args.max_triangles)
    except MeshError as error:
        print(str(error), file=sys.stderr)
        print(json.dumps({"ok": False, "code": error.code, "message": str(error)}, ensure_ascii=False), flush=True)
        return error.exit_code
    except Exception as error:
        traceback.print_exc()
        print(json.dumps({"ok": False, "code": "STEP_MESH_FAILED", "message": tail(error)}, ensure_ascii=False), flush=True)
        return 4
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    # Windows 下 pipe 的 stdout 默认是 GBK（cp936），Node 侧按 UTF-8 读，必须显式改写。
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    sys.exit(main())
