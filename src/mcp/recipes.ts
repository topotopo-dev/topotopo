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
            keel: [[0, 0, -0.65], [0, -0.075, -0.58], [0, -0.13, -0.33], [0, -0.14, 0], [0, -0.12, 0.34], [0, -0.06, 0.58], [0, 0.01, 0.65]],
            sill: [[0, 0, -0.65], [0.1, -0.06, -0.58], [0.158, -0.099, -0.33], [0.186, -0.1, 0], [0.161, -0.085, 0.34], [0.08, -0.04, 0.58], [0, 0.01, 0.65]],
            belt: [[0, 0, -0.65], [0.135, 0, -0.58], [0.225, 0.005, -0.33], [0.249, 0.005, 0], [0.211, 0.012, 0.34], [0.105, 0.012, 0.58], [0, 0.01, 0.65]],
            shoulder: [[0, 0, -0.65], [0.095, 0.065, -0.58], [0.163, 0.119, -0.33], [0.173, 0.154, 0], [0.152, 0.119, 0.34], [0.075, 0.055, 0.58], [0, 0.01, 0.65]],
            roof: [[0, 0, -0.65], [0, 0.09, -0.58], [0, 0.171, -0.33], [0, 0.211, 0], [0, 0.155, 0.34], [0, 0.075, 0.58], [0, 0.01, 0.65]],
          },
          mirror: 'x', ends: 'round', fit_levels: 2, rows_between: [1, 0, 0, 1],
          stations: [-0.65, -0.58, -0.48, -0.35, -0.24, -0.12, 0, 0.1, 0.22, 0.35, 0.48, 0.58, 0.65],
          creases: { belt: [[-0.49, 0], [-0.24, 2.2], [0.25, 2.2], [0.49, 0]] },
          groups: { intake: { between: ['belt', 'shoulder'], from: -0.24, to: -0.12 } },
        } },
        inset: { type: 'poly_extrude', in: ['cage'], params: { group: 'intake', distance: -0.018, inset: 0.008 } },
        skin: { type: 'subdivide', in: ['inset'], params: { levels: 2 } },
        body: { type: 'material', in: ['skin'], params: { name: 'shell', base_color: [0.32, 0.49, 0.57], roughness: 0.34 } },
      },
      output: 'body',
    },
    notes: [
      'Draw the lines first. The side and plan views of each line together give its 3D points.',
      'Four to seven well-placed points per line read smoother than many, and cv helps when the numbers are rough.',
      'Bring the lines together at a tip and use round for noses, tails and domes; use point only for a sharp tip and cap for a flat end with a hard rim.',
      'Place an intake, lamp or outlet face with stations and rows_between, select it with groups, and inset and push it in with poly_extrude before subdivide to avoid jagged or cross-shaped openings.',
      'To grow a spout or pod from the body, use poly_extrude on a cage group before subdivide.',
      'Match fit_levels to the levels in subdivide.',
      'Count a quad mesh’s triangles with nvertices(0) - 2 * nprims(0) and keep the output in quads.',
      'Check the surface from several sides with shading "zebra" (bands that bend smoothly mean a smooth surface; a kink or wobble shows a problem) and with "matcap" plus grey for the form.',
    ],
  },
  {
    name: 'smooth_body_from_a_drawing',
    title: 'Smooth body with openings, from a drawing',
    in: 'Section sizes read from a drawing, named outlines for the openings, and the bands for each opening',
    out: 'An exact NURBS skin with the openings cut, made into a quad game mesh with a seal and frame round the windows and a recess round the vent',
    graph: {
      nodes: {
        profile: { type: 'circle', params: { plane: 'xy', radius: 1, segments: 24 } },
        skin: { type: 'loft', in: ['profile'], params: {
          output: 'surface', fit: 'approximate', tolerance: 0.002, smoothing: 1,
          sections: [
            { offset: [0, 0.16, -0.62], scale: [0.004, 0.004] }, { offset: [0, 0.17, -0.5], scale: [0.12, 0.1] },
            { offset: [0, 0.19, -0.2], scale: [0.2, 0.16] }, { offset: [0, 0.2, 0.15], scale: [0.21, 0.18] },
            { offset: [0, 0.18, 0.45], scale: [0.15, 0.13] }, { offset: [0, 0.15, 0.62], scale: [0.004, 0.004] },
          ],
        } },
        window: { type: 'curve', params: { closed: true, points: [[0, 0.13, -0.2], [0, 0.23, -0.14], [0, 0.23, 0.1], [0, 0.13, 0.17]] } },
        window_name: { type: 'attrib_create', in: ['window'], params: { name: 'name', class: 'prim', type: 'string', value: 'window' } },
        vent: { type: 'curve', params: { closed: true, points: [[-0.05, 0, 0.26], [0.05, 0, 0.26], [0.05, 0, 0.38], [-0.05, 0, 0.38]] } },
        vent_name: { type: 'attrib_create', in: ['vent'], params: { name: 'name', class: 'prim', type: 'string', value: 'vent' } },
        side_cut: { type: 'trim_surface', in: ['skin', 'window_name'], params: { direction: [1, 0, 0], hits: 'all', edges: false } },
        top_cut: { type: 'trim_surface', in: ['side_cut', 'vent_name'], params: { direction: [0, 1, 0], hits: 'front', edges: false } },
        mesh: { type: 'surface_to_mesh', in: ['top_cut'], params: { size: 0.02, tolerance: 0.001, bands: {
          window: [{ width: 0.006, depth: -0.004, group: 'seal' }, { width: 0.01, group: 'frame' }],
          vent: [{ width: 0.004, depth: -0.008, group: 'recess' }],
        } } },
      },
      output: 'mesh',
    },
    notes: [
      'From a drawing sheet, blueprint gives the side, top, front and rear outlines as curves at one scale. Read each section’s width from the top view and its height from the side view.',
      'Long lines such as the profile and the plan edge can guide the skin as rails: loft input 1, each rail crossing every section once.',
      'Measured sections wobble in the highlights. Fit approximate with a tolerance of a few millimetres and smoothing around 1, and check the skin with shading "zebra". A few clean sections read smoother than many rough ones.',
      'For a symmetric body, give loft positive-x half sections and mirror x.',
      'Draw each opening as a closed outline in the view where it looks flat, name it, and cut along that view’s axis with trim_surface. Hits all cuts both sides, and hits front only the near one. An outline may run past an open edge of the skin.',
      'Keep both on trim_surface also gives the cut-out patches, for glass or lids.',
      'Keep the skin exact until the end and let surface_to_mesh make the game mesh. Size is the edge length in metres, and bands map outline names to rings round each opening. The quad_share, min_angle and thin_faces stats report the mesh quality.',
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
    name: 'island_with_sea',
    title: 'Island with a sea',
    in: 'Terrain size, hill height and falloff, and the size of the sea plane',
    out: 'An island mesh and a flat sea plane at Y = 0, with named land and water materials in one GLB',
    graph: {
      nodes: {
        hills: { type: 'terrain', params: { size: [72, 58], divisions: [96, 80], height: 16, frequency: 0.053, fractal: 'fbm', octaves: 4, falloff: 1, center: [0, 8, 0], seed: 9 } },
        coast: { type: 'color', in: ['hills'], params: { mode: 'ramp', attrib: 'P.y', range: [0, 8], ramp: [[0, '#d3bc8c'], [0.1, '#bba478'], [0.23, '#778950'], [0.65, '#596847'], [1, '#888875']] } },
        land_material: { type: 'material', in: ['coast'], params: { name: 'land', base_color: '#ffffff', roughness: 0.95 } },
        island: { type: 'attrib_create', in: ['land_material'], params: { name: 'name', class: 'prim', value: 'island' } },
        water: { type: 'grid', params: { size: [92, 78], divisions: [1, 1], plane: 'xz' } },
        sea_material: { type: 'material', in: ['water'], params: { name: 'water', base_color: '#3c91aa', roughness: 0.3 } },
        sea: { type: 'attrib_create', in: ['sea_material'], params: { name: 'name', class: 'prim', value: 'sea' } },
        scene: { type: 'merge', in: ['island', 'sea'] },
      },
      output: 'scene',
      export: { path: 'island.glb', split_by_name: true, vertex_colors: true },
    },
    notes: [
      'Tune terrain falloff and size to change the coast. Leave floor at its default so the radial falloff can take the outer terrain below the sea.',
      'The beach is where the terrain crosses Y = 0. The low end of the color ramp paints sand just above that line.',
      'For a drawn coast, load a grayscale PNG onto a heightfield with heightfield_from_image {layer:"mask", height_max:1, fit:"field"}. Use heightfield_layer with expression "-3 * (1 - mask) + height * mask" to blend from seabed at black to hills at white, then use heightfield_to_mesh.',
    ],
  },
  {
    name: 'objects_on_terrain',
    title: 'Objects placed on terrain',
    in: 'A terrain mesh, chosen X and Z positions, and a house with its pivot at ground level',
    out: 'Three upright houses snapped to the terrain as packed instances of one house',
    graph: {
      nodes: {
        terrain: { type: 'terrain', params: { size: [30, 25], divisions: [64, 64], height: 1.7, frequency: 0.11, seed: 4 } },
        ground: { type: 'material', in: ['terrain'], params: { name: 'grass', base_color: '#78895a', roughness: 0.9 } },
        sites: { type: 'points', params: { positions: [[-8, 5, -4], [1, 5, 3], [8, 5, -5]] } },
        snapped: { type: 'ray', in: ['sites', 'terrain'], params: { direction: [0, -1, 0], bidirectional: false, orient: false, delete_misses: true } },
        walls: { type: 'box', params: { size: [3.8, 2.58, 3.2], center: [0, 0.81, 0] } },
        plaster: { type: 'material', in: ['walls'], params: { name: 'plaster', base_color: '#e3d5b6' } },
        gable: { type: 'curve', params: { closed: true, points: [[-2.15, 2.1, -1.8], [2.15, 2.1, -1.8], [0, 3.35, -1.8]] } },
        roof: { type: 'poly_extrude', in: ['gable'], params: { distance: 3.6, keep_back: true } },
        tiles: { type: 'material', in: ['roof'], params: { name: 'tiles', base_color: '#a05a42' } },
        house: { type: 'merge', in: ['plaster', 'tiles'] },
        houses: { type: 'copy_to_points', in: ['house', 'snapped'], params: { pack: true } },
        scene: { type: 'merge', in: ['ground', 'houses'] },
      },
      output: 'scene',
    },
    notes: [
      'Set X and Z in the points node and start above the terrain. Ray changes only Y and drops any point that misses.',
      'Keep ray orient:false for upright houses. To lean them with the slope, set ray orient:true and pass the snapped points through orient {mode:"normal_up", align_axis:"y"} before copying. This turns each house’s +Y onto the hit normal.',
      'To scatter many objects instead of placing a few at chosen spots, see Rocks on terrain (rocks_on_terrain).',
    ],
  },
  {
    name: 'prop_variants_and_lods',
    title: 'Prop with variants and LODs',
    in: 'A lamp made of named parts, two shape variants, and points with a variant name at each position',
    out: 'Packed copies of the chosen variants and a published GLB with one lamp mesh per level of detail',
    graph: {
      vars: { lod_spacing: 0 },
      nodes: {
        pole: { type: 'tube', params: { radius: 0.12, radius_top: 0.045, height: 2.2, center: [0, 1.1, 0] } },
        pole_part: { type: 'attrib_create', in: ['pole'], params: { name: 'name', class: 'prim', value: 'pole' } },
        globe: { type: 'sphere', params: { type: 'ico', level: 2, radius: 0.34, center: [0, 2.36, 0] } },
        head_part: { type: 'attrib_create', in: ['globe'], params: { name: 'name', class: 'prim', value: 'head' } },
        lamp: { type: 'merge', in: ['pole_part', 'head_part'] },
        wide_lamp: { type: 'transform', in: ['lamp'], params: { scale: [1.45, 0.67, 1.45] } },
        tall_variant: { type: 'attrib_create', in: ['lamp'], params: { name: 'name', class: 'prim', value: 'tall' } },
        wide_variant: { type: 'attrib_create', in: ['wide_lamp'], params: { name: 'name', class: 'prim', value: 'wide' } },
        variants: { type: 'merge', in: ['tall_variant', 'wide_variant'] },
        sites: { type: 'points', params: { positions: [[-2, 0, 0], [0, 0, 0], [2, 0, 0]], attribs: { variant: ['wide', 'tall', 'wide'] } } },
        lamps: { type: 'copy_to_points', in: ['variants', 'sites'], params: { pack: true, variants: 'name', variant_attrib: 'variant' } },
        lods: { type: 'lod', in: ['lamp'], params: { levels: 3, ratios: [1, 0.6, 0.35], name_format: 'lamp_lod{level}', spacing: ['=lod_spacing', 0, 0] } },
      },
      output: 'lamps',
      outputs: { lods: { node: 'lods', label: 'Lamp LODs', export: { path: 'lamp.glb', split_by_name: true } } },
    },
    notes: [
      'Give every prim of a variant the same name. Each point’s variant string picks that exact name. Integers index names from zero in text order, so 0 picks tall and 1 picks wide.',
      'Feed the lamp with its original part names into lod. The format "lamp_lod{level}" gives every part of a level the same name, and split_by_name writes one mesh per level. Use "{name}_lod{level}" to keep per-part names.',
      'Export the Lamp LODs output to write exports/lamp.glb. Set lod_spacing to 2 for a side-by-side preview and leave it at 0 for export.',
    ],
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
