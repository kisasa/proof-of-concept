import { App } from "cdktn";

import { ListenerStack } from "./stacks/listener";
import { NetworkStack } from "./stacks/network";
import { SpecialistSandboxStack } from "./stacks/specialist-sandbox";
import { TemporalWorkersStack } from "./stacks/temporal-workers";

const app = new App();

// STACKS
const networkStack = new NetworkStack(app);
const listenerStack = new ListenerStack(app);
const specialistSandboxStack = new SpecialistSandboxStack(app);
const temporalWorkersStack = new TemporalWorkersStack(app);

// DEPENDENCIES
// The listener, the specialist sandbox, and the Temporal workers all read the
// network's outputs through remote state, which Terraform cannot see as a
// dependency on its own — the ordering has to be declared. Temporal workers
// also reads the specialist sandbox's outputs, to dispatch against it, and
// the listener reads the Temporal workers' outputs, to connect its own client.
specialistSandboxStack.addDependency(networkStack);
temporalWorkersStack.addDependency(specialistSandboxStack);
listenerStack.addDependency(temporalWorkersStack);

app.synth();
