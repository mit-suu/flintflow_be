---
source: ISO/IEC/IEEE 29148:2018
section: 5.2.4 Requirement construct
topic: requirements
description: How a well-formed requirement statement is built (condition, subject, action, object, constraint)
status: verified
---

A well-formed requirement is a single statement that a stakeholder need is turned into. ISO/IEC/IEEE 29148 describes
its usual parts:

- **Condition** (optional): the situation or trigger in which the requirement applies, for example "when the user
  submits the form".
- **Subject**: the system, software or component that must do something, for example "the system".
- **Action**: what the subject does, written with the binding verb "shall", for example "shall send".
- **Object**: what the action is applied to, for example "a confirmation email".
- **Constraint** (optional): a measurable limit on the action, for example "within 5 seconds".

Putting the parts together gives a sentence such as "When the user submits the form, the system shall send a
confirmation email within 5 seconds." The construct makes each requirement testable: the condition and constraint
tell the tester what to set up and what result to measure. A requirement that cannot be written in this shape usually
mixes several needs, or describes a design choice instead of a capability.
