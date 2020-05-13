/*
 * Copyright © 2019 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {GitProject, HandlerContext, QueryNoCacheOptions} from "@atomist/automation-client";
import {
    DefaultGoalNameGenerator, doWithProject, ExecuteGoal, ExecuteGoalResult,
    FulfillableGoalDetails,
    FulfillableGoalWithRegistrations,
    getGoalDefinitionFrom,
    Goal,
    GoalDefinition,
    ImplementationRegistration,
    IndependentOfEnvironment, LoggingProgressLog,
    mergeOptions, ProjectAwareGoalInvocation, spawnLog,
} from "@atomist/sdm";
import {postLinkImageWebhook, toArray} from "@atomist/sdm-core";
import {
    DefaultDockerImageNameCreator,
    DockerImageNameCreator,
    DockerOptions,
    DockerProgressReporter,
    DockerRegistry, executeDockerBuild,
} from "@atomist/sdm-pack-docker";

/**
 * Options to configure the Docker image build
 */

const DefaultDockerOptions: DockerOptions = {
    dockerImageNameCreator: DefaultDockerImageNameCreator,
    dockerfileFinder: async () => "Dockerfile",
    builder: "docker",
    builderArgs: [],
    builderPath: ".",
};

async function checkIsBuilderAvailable(cmd: string, ...args: string[]): Promise<void> {
    try {
        await spawnLog(cmd, args, { log: new LoggingProgressLog("docker-build-check") });
    } catch (e) {
        throw new Error(`Configured Docker image builder '${cmd}' is not available`);
    }
}

async function readRegistries(ctx: HandlerContext): Promise<DockerRegistry[]> {

    const registries: DockerRegistry[] = [];

    const dockerRegistries = await ctx.graphClient.query<DockerRegistryProvider.Query, DockerRegistryProvider.Variables>({
        name: "DockerRegistryProvider",
        options: QueryNoCacheOptions,
    });

    if (!!dockerRegistries && !!dockerRegistries.DockerRegistryProvider) {

        for (const dockerRegistry of dockerRegistries.DockerRegistryProvider) {
            const credential = await ctx.graphClient.query<Password.Query, Password.Variables>({
                name: "Password",
                variables: {
                    id: dockerRegistry.credential.id,
                },
            });

            // Strip out the protocol
            const registryUrl = new URL(dockerRegistry.url);

            registries.push({
                registry: registryUrl.host,
                user: credential.Password[0].owner.login,
                password: credential.Password[0].secret,
                label: dockerRegistry.name,
                display: false,
            });
        }
    }

    return registries;
}

export function doDockerRun(options: DockerOptions): ExecuteGoal {
    return doWithProject(async gi => {
            const { goalEvent, context, project } = gi;

            const optsToUse = mergeOptions<DockerOptions>(options, {}, "docker.build");

            switch (optsToUse.builder) {
                case "docker":
                    await checkIsBuilderAvailable("docker", "help");
                    break;
                case "kaniko":
                    await checkIsBuilderAvailable("/kaniko/executor", "--help");
                    break;
            }

            // Check the graph for registries if we don't have any configured
            if (!optsToUse.config && toArray(optsToUse.registry || []).length === 0) {
                optsToUse.registry = await readRegistries(context);
            }

            const imageNames = await optsToUse.dockerImageNameCreator?.(project, goalEvent, optsToUse, context);
            const images = _.flatten(
                imageNames.map(imageName =>
                    imageName.tags.map(tag => `${imageName.registry ? `${imageName.registry}/` : ""}${imageName.name}:${tag}`)));
            const dockerfilePath = await (optsToUse.dockerfileFinder ? optsToUse.dockerfileFinder(project) : "Dockerfile");

            const externalUrls: ExecuteGoalResult["externalUrls"] = [];
            // if (await pushEnabled(gi, optsToUse)) {
            //     externalUrls = getExternalUrls(imageNames, optsToUse);
            // }

            // 1. run docker login
            // let result: ExecuteGoalResult = await dockerLogin(optsToUse, gi);
            let result = {code: 0} as ExecuteGoalResult;

            if (result.code !== 0) {
                return result;
            }

            if (optsToUse.builder === "docker") {

                result = await runWithDocker(images, dockerfilePath, gi, optsToUse);

                if (result.code !== 0) {
                    return result;
                }

            } else if (optsToUse.builder === "kaniko") {

                result = await runWithKaniko(images, imageNames || [], dockerfilePath, gi, optsToUse);

                if (result.code !== 0) {
                    return result;
                }
            }

            // 4. create image link
            if (await postLinkImageWebhook(
                goalEvent.repo.owner,
                goalEvent.repo.name,
                goalEvent.sha,
                images[0],
                context.workspaceId)) {
                return {
                    ...result,
                    externalUrls,
                };
            } else {
                return { code: 1, message: "Image link failed" };
            }
        },
        {
            readOnly: true,
            detachHead: false,
        },
    );
}

/**
 * Goal that performs docker build and push depending on the provided options
 */
export class DockerExec extends FulfillableGoalWithRegistrations<DockerOptions> {

    constructor(private readonly goalDetailsOrUniqueName: FulfillableGoalDetails | string = DefaultGoalNameGenerator.generateName("docker-runner"),
                ...dependsOn: Goal[]) {

        super(getGoalDefinitionFrom(
            goalDetailsOrUniqueName,
            DefaultGoalNameGenerator.generateName("docker-runner"),
            DockerBuildDefinition)
            , ...dependsOn);
    }

    public with(registration: DockerOptions): this {
        const optsToUse = mergeOptions<DockerOptions>(DefaultDockerOptions, registration);

        this.addFulfillment({
            goalExecutor: doDockerRun(optsToUse),
            name: DefaultGoalNameGenerator.generateName("docker-runner"),
            progressReporter: DockerProgressReporter,
            ...registration as ImplementationRegistration,
        });
        return this;
    }
}

const DockerBuildDefinition: GoalDefinition = {
    uniqueName: "docker-exec",
    displayName: "docker exec",
    environment: IndependentOfEnvironment,
    workingDescription: "Running docker exec",
    completedDescription: "Docker exec successful",
    failedDescription: "Docker exec failed",
    isolated: true,
    retryFeasible: true,
};

async function runWithDocker(images: string[],
                             dockerfilePath: string,
                             gi: ProjectAwareGoalInvocation,
                             optsToUse: DockerOptions): Promise<ExecuteGoalResult> {
    // 2. run docker build
    const tags = _.flatten(images.map(i => ["-t", i]));

    const result: ExecuteGoalResult = await gi.spawn(
        "docker",
        ["run"],
        // ["run", "-f", , ...tags, ...optsToUse.builderArgs, optsToUse.builderPath],
        {
            env: {
                ...process.env,
                DOCKER_CONFIG: dockerConfigPath(optsToUse, gi.goalEvent),
            },
            log: gi.progressLog,
        },
    );

    if (result.code !== 0) {
        return result;
    }

    return result;
}

async function runWithKaniko(images: string[],
                             imageNames: Array<{ registry: string, name: string, tags: string[] }>,
                             dockerfilePath: string,
                             gi: ProjectAwareGoalInvocation,
                             optsToUse: DockerOptions): Promise<ExecuteGoalResult> {
    throw Error("runWithKaniko unimplemented.");
    return { code: 99 };
}
