# FM Linear workflow integration

FM Linear connects Firstmate's execution of software work with the captain's workflow and conversations in Linear.
This vocabulary describes the integration's model; Firstmate and Linear retain their own models.

## Language

**Captain**:
The person directing the work through Firstmate and the configured Linear workflow.
The captain's account is distinct from the dedicated Firstmate account.

**Crewmate**:
An agent assigned and supervised by Firstmate to perform work.

**Connected work**:
Work whose Firstmate task identities are associated with one or more Linear issues for tracking and communication.
Connection does not transfer scheduling or worker supervision to FM Linear.

**Execution attempt**:
A particular attempt to perform a Firstmate task.
Evidence from an earlier attempt does not establish the state of the current attempt.

**Workflow stage**:
A named part of the user's process with a defined meaning for FM Linear, such as planning, implementation, or plan review.
Its mapped Linear status name is presentation within a team and can differ from the stage key.

**Approval**:
A decision by an authorized reviewer permitting a specified next action for identified work and its relevant artifact revision.
Approval of a plan does not itself authorize merging a later PR.

**Handoff**:
The point at which the workflow asks its next participant to act on the work, such as reviewing a plan.
A handoff is distinct from confirmation that a message reached its recipient.

**Report request**:
A specific question asking Firstmate to establish a necessary fact that available records cannot resolve.
Delivery or acknowledgment of the question does not resolve it.

**Preparation handshake**:
The agreed sequence in which Firstmate requests workflow requirements for a task brief and waits for successful preparation before launch.
The agreement does not establish that every agent dispatch follows the sequence.

**Operational incident**:
A tracked integration problem affecting the user's installation, including its evidence, impact, and recovery state.
Its Linear alert is distinct from a GitHub bug report submitted for project maintainers.
