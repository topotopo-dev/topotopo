# TopoTopo Bench

Language models build 3D assets and scenes with TopoTopo's MCP tools, and the results are compared side by side.
Every model gets the same tools, the same instructions, the same prompt and the same budget. What it leaves behind is
cooked again by the bench, checked, rendered from one fixed camera and exported, so the differences on the page come
from the models.

```bash
# run a model on every task (ANTHROPIC_API_KEY, or any credential the Anthropic SDK finds)
npm run bench:llm -- --model anthropic:claude-opus-5-5

# other providers through their OpenAI-compatible endpoints
npm run bench:llm -- --model openai:<model>            # OPENAI_API_KEY
npm run bench:llm -- --model google:<model>            # GEMINI_API_KEY
npm run bench:llm -- --model openrouter:<vendor/model> # OPENROUTER_API_KEY
npm run bench:llm -- --model deepseek:<model>          # DEEPSEEK_API_KEY
npm run bench:llm -- --model xai:<model>               # XAI_API_KEY
npm run bench:llm -- --model ollama:<model>            # a local Ollama, no key
npm run bench:llm -- --model compat:<model> --base-url http://localhost:8000/v1 --api-key-env MY_KEY

# the hand-written reference solutions (no model): a baseline, and proof that every task can be solved
npm run bench:llm -- --model script:bench/llm/reference --label reference

# the comparison page, from everything in bench/llm/results/
npm run bench:llm:report
python3 -m http.server -d bench/llm/report 8000   # the 3D views load GLBs, so serve the folder (file:// cannot)
```

Options: `--tasks a,b` (a subset), `--label "name on the page"` (default: the model id, with the effort when given),
`--effort low|medium|high|xhigh|max` (Claude's `output_config.effort`; `reasoning_effort` elsewhere), `--tool-calls 40`
and `--minutes 15` (the budget per task), `--no-images` (for text-only models: renders are not sent), `--price in,out`
(USD per million tokens, for a cost estimate where the bench has no list price), `--out` (another results folder).

## What a run does

1. A fresh package in a temporary folder, with the task's input files when it has some (the village task gets a level
   designer's guides as `inputs/markers.json`), and a fresh MCP server on it (`src/mcp/server.ts`, the one users
   connect to their agents).
2. The model gets the server's tools, the bench's short system prompt followed by the server's own instructions, and
   the task's prompt with its budget. It calls tools until it replies without one, or the budget runs out (a call past
   it is answered "not run").
3. The graph the agent changed (`main`, else the one it changed last) is cooked again by the bench. A run that changed
   no graph has no result.
4. The task's checks run on the cooked result; it is rendered (`render.png`, a 960 × 720 three-quarter view, and
   `views.png`, four views) and exported as a meshopt-compressed GLB for the page's 3D view.

Claude runs without refusal fallbacks on purpose: a fallback would answer with another model. A refusal is that
model's result.

## Scores

A task's score is the share of its checks that pass (0–100, weighted by `weight`, default 1); a graph that does not
cook scores 0. The checks are loose on purpose: sizes in metres within a wide range, triangle budgets, pieces,
materials, watertightness, uv, and for the guides task whether the result sits where the guides are. They catch
failures and nonsense; the pictures show the rest. The leaderboard's mean counts a task a model has no result for
as 0.

Every result records how it was made: the model and provider, the settings, the tool calls and turns, the tokens and
an estimated cost, the wall time, why it stopped, its final message, and the full transcript (`transcript.json`).

## Versions

Results are filed by the TopoTopo version they ran on, `results/<version>/<model>/<task>/`, and each records the git
commit and the task suite's hash (`suite`, from the task files and their inputs). The page shows one TopoTopo version
at a time (`index.html` the newest, `<version>.html` the others) and never ranks results of different versions
together: the engine, its tools and their documentation change between versions. Run the models again when a new
version is worth comparing on; older pages stay as they were.

## Tasks

`tasks/<id>.json`: `id`, `title`, `category`, `prompt`, `checks`, and optionally `inputs` (a folder under `tasks/`
whose contents are copied into the package). Check kinds:

| kind | passes when |
|---|---|
| `cooks` | the graph cooks without errors |
| `extent` | the size along `axis` (`x`, `y`, `z`, `longest_horizontal`, `shortest_horizontal`) is within `min`–`max` m |
| `triangles` | the triangle count (packed instances counted out) is within `min`–`max` |
| `pieces` | the number of connected pieces is within `min`–`max` |
| `materials` | the number of distinct prim `material` values is within `min`–`max` |
| `closed` | the mesh is closed and watertight after welding seam splits |
| `uv` | it has a `uv` attribute |
| `covers_inputs` | its footprint covers at least `min` of the footprint of the input `file` |
| `near_points` | there is geometry within `within` m (from above) of every element of `file` in `group` |

A new task needs a reference solution in `reference/<id>.json` (a script of tool calls) that scores 100;
`npm run test:llmbench` checks the suite and the pipeline without a model or a network.
