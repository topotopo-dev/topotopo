// The recipes of the help topic "recipes": one technique each, with a line on what goes in, a line on what comes out
// and a small complete graph (or the example that holds the whole graph). test/recipes.ts cooks every graph, so a
// recipe that is copied is one that works.
import type { GraphSpec } from '../graph/types.ts';
import { graphLines } from './graphlines.ts';

export interface Recipe {
  /** its name in snake_case, unique */
  name: string;
  /** the technique, as a short title */
  title: string;
  /** one line: what goes in (inputs, and the few values a person would change) */
  in: string;
  /** one line: what comes out */
  out: string;
  /** a complete graph for the technique; absent only when the example holds the whole graph */
  graph?: GraphSpec;
  /** an example that holds the whole graph, read with help {examples:[name]} */
  example?: string;
  /** package files the graph reads, each with a few words on what it holds */
  files?: Record<string, string>;
  /** variants and cautions, one per entry */
  notes?: string[];
}

/** The recipes, in the order the topic prints them. */
export const RECIPES: Recipe[] = [
  {
    name: 'flowing_body',
    title: 'Flowing body from lines',
    in: 'Long feature lines along the body and crease weights for the character line',
    out: 'A smooth closed body made of quads, with a named intake group',
    graph: {
      nodes: {
        cage: { type: 'lines_plan', params: {
          lines: {
            keel: [[0, -0.02, -0.65], [0, -0.034, -0.642], [0, -0.051, -0.624],
              [0, -0.13, -0.33], [0, -0.14, 0], [0, -0.12, 0.34], [0, -0.029, 0.624], [0, -0.015, 0.642], [0, -0.004, 0.65]],
            sill: [[0.02, -0.015, -0.65], [0.032, -0.025, -0.642], [0.048, -0.037, -0.624],
              [0.158, -0.099, -0.33], [0.186, -0.1, 0], [0.161, -0.085, 0.34], [0.041, -0.019, 0.624], [0.027, -0.008, 0.642], [0.017, 0, 0.65]],
            belt: [[0.028, 0, -0.65], [0.046, 0, -0.642], [0.069, 0, -0.624],
              [0.225, 0.005, -0.33], [0.249, 0.005, 0], [0.211, 0.012, 0.34], [0.055, 0.011, 0.624], [0.037, 0.012, 0.642], [0.023, 0.012, 0.65]],
            shoulder: [[0.02, 0.015, -0.65], [0.033, 0.024, -0.642], [0.049, 0.035, -0.624],
              [0.163, 0.119, -0.33], [0.173, 0.154, 0], [0.152, 0.119, 0.34], [0.039, 0.042, 0.624], [0.026, 0.032, 0.642], [0.016, 0.025, 0.65]],
            roof: [[0, 0.021, -0.65], [0, 0.035, -0.642], [0, 0.052, -0.624],
              [0, 0.171, -0.33], [0, 0.211, 0], [0, 0.155, 0.34], [0, 0.056, 0.624], [0, 0.042, 0.642], [0, 0.031, 0.65]],
          },
          mirror: 'x', ends: 'cap', fit_levels: 2,
          stations: [-0.65, -0.642, -0.624, -0.58, -0.48, -0.35, -0.24, -0.12, 0, 0.1, 0.22, 0.35, 0.48, 0.58, 0.624, 0.642, 0.65],
          creases: { belt: [[-0.49, 0], [-0.24, 2.2], [0.25, 2.2], [0.49, 0]] },
          groups: { intake: { between: ['belt', 'shoulder'], from: -0.24, to: 0.1 } },
        } },
        skin: { type: 'subdivide', in: ['cage'], params: { levels: 2 } },
        inset: { type: 'poly_extrude', in: ['skin'], params: { group: 'intake', distance: -0.018, inset: 0.008 } },
        body: { type: 'material', in: ['inset'], params: { name: 'shell', base_color: [0.32, 0.49, 0.57], roughness: 0.34 } },
      },
      output: 'body',
    },
    notes: [
      'Draw the lines first. The side and plan views of each line together give its 3D points.',
      'Add more lines or raise rows_between for rounder sections.',
      'Match fit_levels to the levels in subdivide.',
      'Check the surface from several sides with shading "zebra" (bands that bend smoothly mean a smooth surface; a kink or wobble shows a problem) and with "matcap" plus grey for the form.',
      'Use groups after subdivide to cut openings or make glass.',
      'To grow a spout or pod from the body, use poly_extrude on a cage group before subdivide.',
    ],
  },
  {
    name: 'rocks_on_terrain',
    title: 'Rocks on terrain',
    in: 'Nothing to read: the terrain is generated; the scatter count, the seed and the rocks\' size range',
    out: 'One mesh with rocks scattered on the flatter parts of the terrain',
    graph: {
      nodes: {
        terrain: { type: 'terrain', params: { size: [30, 30], height: 4 } },
        samples: { type: 'scatter', in: ['terrain'], params: { count: 150, seed: 2 } },
        flat_spots: { type: 'delete', in: ['samples'], params: { class: 'point', group: '@N.y<0.85' } },
        rock_sizes: { type: 'attrib_randomize', in: ['flat_spots'], params: { name: 'pscale', min: 0.2, max: 0.7 } },
        rock_base: { type: 'sphere', params: { type: 'ico', level: 2 } },
        rock: { type: 'noise_displace', in: ['rock_base'], params: { amplitude: 0.3, frequency: 1.5 } },
        rocks: { type: 'copy_to_points', in: ['rock', 'rock_sizes'] },
        rocky_terrain: { type: 'merge', in: ['terrain', 'rocks'] },
      },
      output: 'rocky_terrain',
    },
  },
  {
    name: 'tree_from_rules',
    title: 'Tree from rules',
    in: 'Nothing to read; the L-system\'s rules, its generations and the leaf size',
    out: 'A tree with tapered branches and a leaf card at each leaf point',
    graph: {
      nodes: {
        tree_rules: { type: 'lsystem', params: { axiom: 'A', rules: { A: 'F[&+A!J][&-A!J][^A!J]' }, generations: 6, tropism_strength: 0.1 } },
        branches: { type: 'polywire', in: ['tree_rules'], params: { divisions: 6 } },
        leaf_points: { type: 'delete', in: ['tree_rules'], params: { class: 'point', group: 'leaves', keep: true } },
        leaf: { type: 'grid', params: { size: [0.2, 0.3], divisions: [1, 1], plane: 'xy' } },
        leaves: { type: 'copy_to_points', in: ['leaf', 'leaf_points'] },
        tree: { type: 'merge', in: ['branches', 'leaves'] },
      },
      output: 'tree',
    },
    notes: ['Polywire uses the branch width from the L-system.', 'For a complete tree with a trunk and canopy, see help {examples:["lsystem_tree"]}.'],
  },
  {
    name: 'stacked_floors',
    title: 'Stacked floors',
    in: 'Nothing to read; the slab size, the number of floors and the storey height',
    out: 'A stack of floor slabs at regular storey heights',
    graph: {
      nodes: {
        floors: { type: 'foreach', params: { mode: 'count', count: 5, body: {
          nodes: {
            slab: { type: 'box', params: { size: [6, 0.22, 4], center: [0, 0.11, 0] } },
            raised_slab: { type: 'transform', in: ['slab'], params: { translate: [0, '=iteration*3', 0] } },
          },
          output: 'raised_slab',
        } } },
      },
      output: 'floors',
    },
  },
  {
    name: 'carved_block',
    title: 'Carved block',
    in: 'Nothing to read; the block\'s size and the cutter\'s size and place',
    out: 'A solid block with a bowl-shaped recess and rounded edges',
    graph: {
      nodes: {
        block: { type: 'box', params: { size: [1.5, 0.9, 1.12] } },
        cutter: { type: 'sphere', params: { type: 'ico', level: 2, radius: 0.43, center: [0.2, 0.49, 0.07] } },
        recess: { type: 'boolean', in: ['block', 'cutter'], params: { operation: 'subtract' } },
        carved_block: { type: 'smooth_solid', in: ['recess'], params: { refine: 4, sharp_angle: 85, smoothness: 0.35 } },
      },
      output: 'carved_block',
    },
    notes: ['Use a capped tube as the cutter for a straight bore.'],
  },
  {
    name: 'shatter',
    title: 'Shatter',
    in: 'A closed mesh (here a sphere); the number of pieces and the gap between them',
    out: 'A fractured sphere with a class attribute for colouring its separated pieces',
    graph: {
      nodes: {
        ball: { type: 'sphere', params: { type: 'ico', level: 2, radius: 0.6 } },
        shards: { type: 'voronoi_fracture', in: ['ball'], params: { count: 20, gap: 0.02 } },
      },
      output: 'shards',
    },
    notes: ['Render with color_by:"class" to see each piece in a different colour.'],
  },
  {
    name: 'sign',
    title: 'Sign',
    in: 'Nothing to read; the lettering, its size and depth, and the board\'s size',
    out: 'A metre-wide sign with raised lettering on its front',
    graph: {
      nodes: {
        lettering: { type: 'text', params: { text: 'HELLO', size: 0.28, depth: 0.03, valign: 'center' } },
        backing: { type: 'box', params: { size: [1.1, 0.35, 0.07], center: [0, 0, -0.035] } },
        sign: { type: 'merge', in: ['backing', 'lettering'] },
      },
      output: 'sign',
    },
  },
  {
    name: 'organic_blob',
    title: 'Organic blob',
    in: 'Nothing to read; the spheres\' places and radii, the blend and the noise',
    out: 'A watertight mesh with two blended lobes and an uneven surface',
    graph: {
      nodes: {
        lumpy_field: { type: 'sdf_expr', params: {
          bounds_min: [-0.9, -0.6, -0.6], bounds_max: [0.85, 0.65, 0.65],
          code: 'const lobes = smin(sdSphere(sub(p, [-0.27, 0, 0]), 0.48), sdSphere(sub(p, [0.32, 0.08, 0.05]), 0.37), 0.28);\nreturn lobes + 0.06 * noise(mul(p, 5));',
        } },
        blob: { type: 'sdf_to_mesh', in: ['lumpy_field'], params: { edge_length: 0.055 } },
      },
      output: 'blob',
    },
  },
  {
    name: 'pipes',
    title: 'Pipes',
    in: 'The route as curve points; the pipe\'s radius',
    out: 'A round pipe with smooth bends and capped ends',
    graph: {
      nodes: {
        route: { type: 'curve', params: { points: [[0, 0.1, 0], [0.55, 0.1, 0], [0.86, 0.1, 0.14], [0.9, 0.1, 0.5], [0.9, 0.35, 0.72]], smooth: true } },
        section: { type: 'circle', params: { plane: 'xy', radius: 0.05, segments: 12 } },
        pipe: { type: 'sweep', in: ['route', 'section'] },
      },
      output: 'pipe',
    },
    notes: ['For a round tube without a separate profile, use polywire on the curve.'],
  },
  {
    name: 'panel_greebles',
    title: 'Panel greebles',
    in: 'Nothing to read; the grid\'s divisions, which faces rise and how far',
    out: 'A panel with individually raised and coloured faces of varying heights on one side',
    graph: {
      nodes: {
        panel: { type: 'grid', params: { size: [2.4, 1.2], divisions: [8, 4], plane: 'xz' } },
        raised_faces: { type: 'poly_extrude', in: ['panel'], params: { group: '@P.x>0', mode: 'individual', distance: 0.035, inset: 0.035 } },
        varied_heights: { type: 'wrangle', in: ['raised_faces'], params: {
          run_over: 'prims', group: 'front',
          code: 'const rise = 0.1 * rand(@primnum, 7);\nfor (const pt of primpoints(0, @primnum)) {\n  const p = point(0, "P", pt);\n  setpointattrib(0, "P", pt, [p.x, p.y + rise, p.z]);\n}',
        } },
        caps: { type: 'group', in: ['varied_heights'], params: { class: 'prim', name: 'caps', pattern: 'front' } },
        tinted_panel: { type: 'color', in: ['caps'], params: { class: 'prim', group: 'caps', color: '#d88435' } },
      },
      output: 'tinted_panel',
    },
  },
  {
    name: 'bend_with_a_cage',
    title: 'Bend with a cage',
    in: 'A mesh (here a column); the bend angle and the cage\'s divisions, the same on bound and on lattice',
    out: 'A bent column whose shape follows the deformed bounding cage',
    graph: {
      nodes: {
        column: { type: 'tube', params: { radius: 0.25, height: 2.4, rows: 24, center: [0, 1.2, 0] } },
        cage: { type: 'bound', in: ['column'], params: { divisions: [1, 6, 1] } },
        bent_cage: { type: 'bend', in: ['cage'], params: { angle: 70 } },
        bent_column: { type: 'lattice', in: ['column', 'bent_cage'], params: { divisions: [1, 6, 1] } },
      },
      output: 'bent_column',
    },
  },
  {
    name: 'wrap_along_a_curve',
    title: 'Wrap along a curve',
    in: 'A mesh laid along +Z and a curve to follow',
    out: 'A strip bent and stretched to follow the full curve',
    graph: {
      nodes: {
        strip: { type: 'box', params: { size: [0.35, 0.06, 2.5], center: [0, 0, 1.25], divisions: [1, 1, 32] } },
        path: { type: 'curve', params: { points: [[0, 0, 0], [0.15, 0, 1], [0.95, 0.25, 1.65], [0.85, 0.55, 2.5], [0.1, 0.65, 3.2]], smooth: true } },
        wrapped_strip: { type: 'path_deform', in: ['strip', 'path'], params: { stretch: true } },
      },
      output: 'wrapped_strip',
    },
  },
  {
    name: 'pull_a_spot',
    title: 'Pull a spot',
    in: 'A mesh and a point group for the spot; how far it is pulled and how far the pull reaches',
    out: 'A surface with a raised centre that falls back smoothly to the flat grid',
    graph: {
      nodes: {
        sheet: { type: 'grid', params: { size: [3, 2], divisions: [24, 16], plane: 'xz' } },
        centre_spot: { type: 'group', in: ['sheet'], params: { name: 'spot', class: 'point', bbox_min: [-0.01, -0.01, -0.01], bbox_max: [0.01, 0.01, 0.01] } },
        pulled_sheet: { type: 'soft_transform', in: ['centre_spot'], params: { group: 'spot', translate: [0, 0.6, 0], radius: 0.85 } },
      },
      output: 'pulled_sheet',
    },
  },
  {
    name: 'deform_by_a_proxy',
    title: 'Deform by a proxy',
    in: 'A detailed mesh, a coarse set of points at rest and the same points moved',
    out: 'A detailed bar that follows the movement and local rotation of the coarse proxy',
    graph: {
      nodes: {
        bar: { type: 'box', params: { size: [2.4, 0.15, 0.35], divisions: [32, 2, 4] } },
        rest_proxy: { type: 'point_grid', params: { size: [2.4, 0.2, 0.45], counts: [8, 2, 3] } },
        bent_proxy: { type: 'bend', in: ['rest_proxy'], params: { axis: 'x', toward: 'z', angle: 105 } },
        bent_bar: { type: 'point_deform', in: ['bar', 'rest_proxy', 'bent_proxy'] },
      },
      output: 'bent_bar',
    },
    notes: ['Add rest to the geometry before deforming so patterns from noise_displace and attrib_noise stick to the surface.'],
  },
  {
    name: 'loop_cuts_and_extrude',
    title: 'Loop cuts and extrude',
    in: 'A block; the edge the cuts cross, their count, and the band\'s distance and inset',
    out: 'A block with a raised band between two loop cuts',
    graph: {
      nodes: {
        block: { type: 'box', params: { size: [0.8, 1.65, 0.7] } },
        loop_cuts: { type: 'polysplit', in: ['block'], params: { edge: 'length>1.2', count: 2 } },
        band: { type: 'group_promote', in: ['loop_cuts'], params: { group: 'split', from: 'point', to: 'prim', include: 'all', new_name: 'band', delete_source: false } },
        raised_band: { type: 'poly_extrude', in: ['band'], params: { group: 'band', distance: 0.1, inset: 0.03 } },
      },
      output: 'raised_band',
    },
    notes: [
      'Bevel the rims with poly_bevel or subdivide with creases.',
      'Knife splits along a plane and puts the cut in the edge group "cut".',
      'Use polybridge {source:"border:a", target:"border:b", delete_inner_faces:true} to tunnel between two face groups.',
      'Use polyfill {mode:"grid"} to cap holes with quads.',
      'Use dissolve {group:"split"} to remove the loops again.',
    ],
  },
  {
    name: 'bevelled_edges',
    title: 'Bevelled edges',
    in: 'A mesh; the angle that picks the edges, the bevel\'s offset and its divisions',
    out: 'A block with rounded edges wherever the adjacent faces meet at a sharp angle',
    graph: {
      nodes: {
        block: { type: 'box', params: { size: [0.9, 0.35, 0.65] } },
        rounded_edges: { type: 'poly_bevel', in: ['block'], params: { group: 'angle>80', offset: 0.05, divisions: 3 } },
      },
      output: 'rounded_edges',
    },
    notes: [
      'Set divisions to 0 for a chamfer.',
      'Set shape to 1 for a squarer profile, -0.5 for a flat profile, or -1 for a cove.',
      'To bevel only the rim of a slab, extrude it and use poly_bevel {group:"border:top"}.',
    ],
  },
  {
    name: 'clean_asset_pipeline',
    title: 'Clean asset pipeline',
    in: 'A broken or scanned mesh; the edge length, the texel density and the LOD ratios',
    out: 'A repaired and unwrapped mesh with several levels of detail',
    example: 'asset_cleanup',
    notes: [
      'Use mesh_repair to fuse points, fix winding and fill small holes, then read the detail attribute repair_report.',
      'Use remesh_isotropic with target_length and feature_angle:40 for even triangles before uv_unwrap or simulation, or set target_attrib for adaptive size.',
      'After uv_unwrap, lod {levels:4, ratios:[1,0.5,0.25,0.1]} writes the prim attributes lod and name, with names such as {name}_lod0… from name_format.',
      'Export with split_by_name, use a group such as "@name=panel" for one part, or use mode:"switch" and level to get one level with the same naming.',
      'For one level you can also use decimate with ratio and attributes:"uv N".',
      'A level that stops short warns about constraints such as UV seams, hard normals and group or prim attribute borders.',
      'Reduce before unwrapping and compute vertex normals after lod if those constraints hold back the reduction.',
      'Use remesh_quad {target_faces:2000, feature_angle:45} for field-aligned quad-dominant polygons with point, vertex and prim attributes.',
      'Its mode:"quads_only" conformingly subdivides all faces and can exceed target_faces, especially along hard curves.',
      'Set crease_group to align explicit edges and group to keep its border fixed.',
      'Inspect the wireframe and the detail attributes quad_fraction and singularities.',
      'Use voxel remesh only when the input is beyond repair because it drops attributes.',
      'The whole example shows the process from a scan to LODs.',
    ],
  },
  {
    name: 'weather_a_prop',
    title: 'Weather a prop',
    in: 'A UV-mapped prop with a kind for each material, plus wear, dirt, rust, age and exposure',
    out: 'A weathered mesh with one material, colour, normal and ORM maps, and named weathering masks',
    example: 'weathered_cabinet',
    notes: ['See worn_machine for the same weathering building blocks wired directly, with an oil stain under the motor.'],
  },
  {
    name: 'street_from_packages',
    title: 'Street from packages',
    in: 'Nothing to read; the street\'s length and width, the houses\' size, the lamp spacing and the park\'s density',
    out: 'A street with buildings, kerbs, pavements, lamps, props and a park built from TopoTopo packages',
    example: 'market_street',
    notes: [
      'See help topic "packages" for how to use the built-in packages.',
      'Put topotopo/street/road_strip on a line and pack topotopo/street/lamp_post onto points_along_curve using side_offset and both_sides.',
      'Build a house from four topotopo/architecture/wall_segment walls, rotating the street-facing wall 180° and the sides ±90°, with door:true on the front.',
      'Translate topotopo/architecture/roof_gable or topotopo/architecture/roof_hip to the wall top.',
      'Place topotopo/street/fence and bench, topotopo/props/crate and topotopo/nature/tree_lowpoly with transform or copy_to_points.',
      'Put topotopo/nature/forest_patch on a grid for a park.',
    ],
  },
  {
    name: 'instance_a_placement_list',
    title: 'Instance a placement list',
    in: 'The pieces as mesh files and a list with a position, yaw, scale and piece name per row',
    out: 'Packed copies placed by name that can be exported as one instanced GLB',
    graph: {
      nodes: {
        crate: { type: 'file', params: { path: 'pieces/crate.glb' } },
        crate_n: { type: 'attrib_create', in: ['crate'], params: { name: 'name', class: 'prim', value: 'crate' } },
        barrel: { type: 'file', params: { path: 'pieces/barrel.glb' } },
        barrel_n: { type: 'attrib_create', in: ['barrel'], params: { name: 'name', class: 'prim', value: 'barrel' } },
        pieces: { type: 'merge', in: ['crate_n', 'barrel_n'] },
        spots: { type: 'file', params: { path: 'inputs/placements.json' } },
        layout: { type: 'copy_to_points', in: ['pieces', 'spots'], params: { pack: true, variants: 'name', variant_attrib: 'name', rotate_attrib: 'yaw' } },
      },
      output: 'layout',
    },
    files: {
      'pieces/crate.glb': 'crate mesh',
      'pieces/barrel.glb': 'barrel mesh',
      'inputs/placements.json': 'placement rows',
    },
    notes: [
      'Each JSON row looks like {"P":[2,0,0],"yaw":45,"pscale":1.2,"name":"barrel"} and each key becomes a point attribute.',
      'You can also use a CSV with columns P.x,P.y,P.z,yaw,pscale,name.',
      'Use orient.x…w or N and up in place of yaw, and use scale for per-axis scale.',
      'Yaw is in degrees, counter-clockwise seen from above, so flip the sign for a clockwise list from Unreal.',
      'You can use a package output in place of each piece file.',
      'You can also read a folder with file {path:"pieces"}, which names each piece after its file stem or "<stem>/<part>" for a file with several named parts.',
      'Use wrangle {run_over:"prims", code:"s@name = @name.split(\'/\')[0];"} to treat a file with several named parts as one piece again.',
      'Rows naming a missing piece produce a warning and no copy.',
      'Export to GLB for one mesh per piece with EXT_mesh_gpu_instancing (see help topic "instancing").',
    ],
  },
];

/** The help topic "recipes", rendered from the list. */
export function recipesText(): string {
  const lines = ['RECIPES (copy, then adapt)'];
  for (const [index, recipe] of RECIPES.entries()) {
    lines.push(`${index + 1}) ${recipe.title}`, ` in:  ${recipe.in}`, ` out: ${recipe.out}`);
    if (recipe.graph) lines.push(...graphLines(recipe.graph).split('\n').map((line) => ` ${line}`));
    if (recipe.files) lines.push(` files: ${Object.entries(recipe.files).map(([file, desc]) => `${file} (${desc})`).join(', ')}`);
    if (recipe.example) lines.push(` whole graph: help {examples:[${JSON.stringify(recipe.example)}]}`);
    for (const note of recipe.notes ?? []) lines.push(` - ${note}`);
  }
  return lines.join('\n');
}
