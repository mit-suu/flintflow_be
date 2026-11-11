# Deployment (S-6.1 only, FLF-390)

The deployment diagram is **not** part of the FlintFlow (FPT) template. Write `deployment_nodes` / `deployment_links`
**only** when the user asks for a deployment diagram (chat or change request), or when the section being written is the
"Distribution" part of "Design and Implementation" of an IEEE template (`slot:distribution`) - and then only from what the
documents or the user say about where the software runs (servers, cloud services, devices, databases, runtimes).
Nothing said ⇒ no deployment data (no diagram). Normal S-6 steps never touch these arrays.

- `deployment_nodes[]`: `{ id: "$dn1", "$dn2"… (placeholder, the server issues `DN<nn>`), name, kind, parent_id, artifacts: [], components: [], description? }`, one
  `add` per node, parents before children (refer to a parent or a link end added in the same batch by its placeholder).
  - `kind`: `device` = physical hardware or a server machine (Web Server, Mobile Phone); `execution_environment` = software
    that hosts other software (Ubuntu 24.04, Node.js runtime, Docker container, PostgreSQL 16) - put it **inside** its
    device with `parent_id`; `node` = anything else (a cloud service, an external system).
  - `components`: the software modules running on the node, named as elsewhere in the SRS (Web Application, API Service).
  - `artifacts`: deployable files / packages when the documents name them (api.jar, web-bundle.zip); else `[]`.
- `deployment_links[]`: `{ from, to, protocol? }` per communication path between two nodes (node ids), one per pair;
  `protocol` = HTTPS, JDBC, AMQP… as written. One `add` per link, after both nodes exist.
- External systems that are `actors[kind=system]` may be a `node` with a link, so the diagram shows the connection;
  their interface requirement is still an `nfrs` row.

## Self-check

- [ ] Deployment data only on the user's request or for the IEEE Distribution part, only from what the documents / user say; devices hold their execution environments.
- [ ] Unique node names, one link per pair of nodes, protocol written on the link when known.
