---
skill_id: deployment
kind: renderer
version: 1.0.0
description: "S-6.1 Deployment Diagram, physical placement of the software on hardware nodes (UML 2.5, PlantUML source built in code: one diagram for the system, in §4.1 External Interfaces)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0.1
reads:
  - "deployment_nodes[]"
  - "deployment_links[]"
writes:
  - "diagrams[kind=deployment]"
output_schema: none
language: en
stub: false
---
# Deployment

> The renderer is deterministic code: `src/modules/diagram/renderers/deployment.renderer.ts` (data → `.puml`). The path is `puml` (PlantUML server, compile-check; `render_fix` may repair syntax only). This skill documents the output.

- Step: S-6.1 External Interfaces · `owner_kind = null`, one diagram for the whole system · Output: `puml`
- Where it is printed: **IEEE template** ⇒ under "Distribution" (Phân tán) of "Design and Implementation" (`slot:distribution`); the heading is inserted (with its parent when missing, before the appendices) when the file has none. **FPT (FlintFlow) template** ⇒ not part of the template: only when the user asks, printed under §4.1 External Interfaces after the interface list.
- IEEE 830 §3.1 / ISO/IEC/IEEE 29148 external interfaces (hardware, software, communications): the deployment diagram shows how the software components are physically placed on hardware nodes and how the nodes talk to each other. It is a high-level view of the system architecture for planning the deployment, the communication and the documentation.
- **No data, no diagram**: `deployment_nodes[]` empty ⇒ no diagram; nothing is guessed from the interface list.

## Principles (Visual Paradigm, "Beginner's guide to deployment diagrams")

1. A deployment diagram shows how software modules, databases and other elements are spread across servers, computers and devices.
2. **Node** (nút) = a hardware device or server. **Component** (thành phần) = a software module or application. **Artifact** = a file or executable deployed on a node, attached to show the concrete files.
3. **Deployment connection** links a component to the node it is deployed on (drawn here by nesting the component inside the node). **Relationship** shows how nodes and components relate (example: a web server node contains a web application component).
4. **Stereotypes** clarify the role of an element. Notes are only for information the diagram cannot show; never a note that repeats the description below the figure.
5. Arrange and format for clarity: aligned, readable, nothing overlapping.

The article does not fix shapes, line styles or naming. Those come from UML 2.5 below.

## Notation (UML 2.5)

| Spine | UML element | Drawn as |
| --- | --- | --- |
| `deployment_nodes[kind=device]` | Device (physical hardware: server, phone, router) | 3D box `node "<name>" <<device>>`, fill `#7ACFF5` |
| `deployment_nodes[kind=execution_environment]` | Execution environment (OS, runtime, container, DBMS) | 3D box `<<executionEnvironment>>`, nested in its device |
| `deployment_nodes[kind=node]` | Node (general computational resource) | 3D box, no stereotype |
| `deployment_nodes[].parent_id` | Nesting | the child box is drawn inside the parent box |
| `deployment_nodes[].components[]` | Component deployed on the node | component box (UML 2 icon) inside the node |
| `deployment_nodes[].artifacts[]` | Artifact deployed on the node | artifact (document icon) inside the node |
| `deployment_links[]` | Communication path | solid line, no arrowhead, label = `protocol` (`HTTPS`, `JDBC`, `AMQP`) |

- Names: nodes are nouns of the real thing (`Web Server`, `PostgreSQL 16`, `Mobile Phone`); components are the module names used elsewhere in the SRS (`Web Application`); artifacts are file / package names (`api.jar`, `web-bundle.zip`). Exact names, English, no diacritics in the source.
- Aliases are Spine ids (`DN01`), elements sorted by id ⇒ the same Spine gives the same source. Layout is left to right; PlantUML places the boxes.
- One communication path per pair of nodes; several protocols on one path are written in one label (`HTTPS / WebSocket`).
- Caption `Deployment Diagram` (`Sơ đồ triển khai` in a Vietnamese document) and one description paragraph under the figure (number of nodes, devices, execution environments and communication paths).

## Data rules (op validator `deploymentErrors`)

- Node names are unique; `parent_id` points to an existing node, no parent cycle, a device is never inside an execution environment.
- A link joins two different existing nodes; one link per pair of nodes.
- An external system that is an actor (`actors[kind=system]`) and runs outside the product may appear as a `node` so its communication path can be drawn; the interface requirement itself stays in `nfrs[category=interface]`.
