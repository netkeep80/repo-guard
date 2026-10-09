import { extractLinkedIssueReferences } from "../change-intent.mjs";
const EXACT_SHA = /^[0-9a-f]{40}$/i;
function fail(label, message) {
    throw new Error(`${label}: ${message}`);
}
function text(value, label) {
    if (typeof value !== "string" || !value.trim())
        fail(label, "must be a non-empty string");
    return value.trim();
}
function sha(value, label) {
    const normalized = text(value, label).toLowerCase();
    if (!EXACT_SHA.test(normalized))
        fail(label, "must be an exact 40-hex commit SHA");
    return normalized;
}
function positiveInteger(value, label) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
        fail(label, "must be a positive integer");
    return value;
}
function record(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail(label, "must be an object");
    return value;
}
function list(value, label) {
    if (!Array.isArray(value))
        fail(label, "must be an array");
    return value;
}
function issueState(value, label) {
    if (value !== "open" && value !== "closed")
        fail(label, "must be open or closed");
    return value;
}
function prState(value, label) {
    if (value !== "open" && value !== "closed")
        fail(label, "must be open or closed");
    return value;
}
function issueIdentity(number) { return `issue:#${number}`; }
function prIdentity(number) { return `pr:#${number}`; }
function branchIdentity(name, commit) { return `branch:${name}@${commit}`; }
function numbers(value) {
    return [...value.matchAll(/#([1-9][0-9]*)\b/g)].map((match) => Number(match[1]));
}
function issueBodyRelations(issue) {
    const out = [];
    const lines = issue.body.split(/\r?\n/);
    let continuation = null;
    const add = (kind, target, detail) => {
        if (target === issue.number)
            return;
        out.push({
            kind,
            from: issueIdentity(issue.number),
            to: issueIdentity(target),
            provenance: { source: "github_issue_body", owner: issueIdentity(issue.number), detail },
        });
    };
    for (const rawLine of lines) {
        const line = rawLine.trim();
        const parent = line.match(/^(?:parent(?:\s+roadmap)?|roadmap|родительский\s+(?:roadmap|issue))\s*:\s*(.*)$/i);
        if (parent) {
            continuation = "parent";
            for (const target of numbers(parent[1] || ""))
                add("parent", target, line);
            continue;
        }
        const partOf = line.match(/^part\s+of\b(.*)$/i);
        if (partOf) {
            continuation = null;
            for (const target of numbers(partOf[1] || ""))
                add("parent", target, line);
            continue;
        }
        const related = line.match(/^(?:related(?:\s+issues?)?|depends\s+on|dependencies|связанные\s+исследования)\s*:\s*(.*)$/i);
        if (related) {
            continuation = "related";
            for (const target of numbers(related[1] || ""))
                add("related", target, line);
            continue;
        }
        if (continuation && /^[-*]\s+/.test(line)) {
            for (const target of numbers(line))
                add(continuation, target, line);
            continue;
        }
        if (line)
            continuation = null;
    }
    return out;
}
function reachableIssues(root, openIssues, relations) {
    if (root === null || !openIssues.has(root))
        return new Set();
    const adjacency = new Map();
    for (const relation of relations) {
        if (relation.kind !== "parent" && relation.kind !== "related")
            continue;
        const from = Number(relation.from.replace("issue:#", ""));
        const to = Number(relation.to.replace("issue:#", ""));
        if (!Number.isInteger(from) || !Number.isInteger(to))
            continue;
        const targets = adjacency.get(from) || new Set();
        targets.add(to);
        adjacency.set(from, targets);
    }
    const memo = new Map();
    const reaches = (number, visiting = new Set()) => {
        if (number === root)
            return true;
        if (memo.has(number))
            return memo.get(number);
        if (visiting.has(number))
            return false;
        visiting.add(number);
        const result = [...(adjacency.get(number) || [])].some((target) => openIssues.has(target) && reaches(target, new Set(visiting)));
        memo.set(number, result);
        return result;
    };
    return new Set([...openIssues].filter((number) => reaches(number)));
}
export function controlPlaneObservationFromGitHub(input) {
    const repository = text(input.repository, "GitHubControlPlane.repository");
    const metadata = record(input.repository_metadata, "GitHubControlPlane.repository_metadata");
    const rawIssues = list(input.issues, "GitHubControlPlane.issues")
        .map((value, index) => record(value, `GitHubControlPlane.issues[${index}]`))
        .filter((value) => value.pull_request == null);
    const issues = rawIssues.map((value, index) => ({
        number: positiveInteger(value.number, `GitHubControlPlane.issues[${index}].number`),
        state: issueState(value.state, `GitHubControlPlane.issues[${index}].state`),
        title: typeof value.title === "string" ? value.title : "",
        body: typeof value.body === "string" ? value.body : "",
    }));
    const inferredRoots = issues
        .filter((issue) => issue.state === "open" && /^\[Roadmap\]/i.test(issue.title || ""))
        .map((issue) => issue.number);
    const rootIssueNumber = input.root_issue_number === undefined
        ? inferredRoots.length === 1 ? inferredRoots[0] : null
        : input.root_issue_number;
    const branches = list(input.branches, "GitHubControlPlane.branches").map((value, index) => {
        const branch = record(value, `GitHubControlPlane.branches[${index}]`);
        const commit = record(branch.commit, `GitHubControlPlane.branches[${index}].commit`);
        return {
            name: text(branch.name, `GitHubControlPlane.branches[${index}].name`),
            sha: sha(commit.sha, `GitHubControlPlane.branches[${index}].commit.sha`),
            protected: branch.protected === true,
        };
    });
    const pullRequests = list(input.pull_requests, "GitHubControlPlane.pull_requests").map((value, index) => {
        const pr = record(value, `GitHubControlPlane.pull_requests[${index}]`);
        const head = record(pr.head, `GitHubControlPlane.pull_requests[${index}].head`);
        const headRepository = head.repo && typeof head.repo === "object" && !Array.isArray(head.repo)
            ? head.repo
            : null;
        return {
            number: positiveInteger(pr.number, `GitHubControlPlane.pull_requests[${index}].number`),
            state: prState(pr.state, `GitHubControlPlane.pull_requests[${index}].state`),
            draft: pr.draft === true,
            merged: pr.merged === true || pr.merged_at !== null && pr.merged_at !== undefined,
            body: typeof pr.body === "string" ? pr.body : "",
            head: {
                ref: text(head.ref, `GitHubControlPlane.pull_requests[${index}].head.ref`),
                sha: sha(head.sha, `GitHubControlPlane.pull_requests[${index}].head.sha`),
                repo_full_name: typeof headRepository?.full_name === "string" ? headRepository.full_name : null,
            },
        };
    });
    return {
        repository,
        default_branch: text(metadata.default_branch, "GitHubControlPlane.repository_metadata.default_branch"),
        delete_branch_on_merge: typeof metadata.delete_branch_on_merge === "boolean" ? metadata.delete_branch_on_merge : null,
        root_issue_number: rootIssueNumber,
        branches,
        issues,
        pull_requests: pullRequests,
    };
}
export function analyzeControlPlaneObservation(input) {
    const repository = text(input.repository, "ControlPlane.repository");
    const defaultBranch = text(input.default_branch, "ControlPlane.default_branch");
    const rootIssueNumber = input.root_issue_number == null ? null : positiveInteger(input.root_issue_number, "ControlPlane.root_issue_number");
    const branchNames = new Set();
    const branches = input.branches.map((branch, index) => {
        const name = text(branch.name, `ControlPlane.branches[${index}].name`);
        if (branchNames.has(name))
            fail(`ControlPlane.branches[${index}].name`, `duplicate branch "${name}"`);
        branchNames.add(name);
        const commit = sha(branch.sha, `ControlPlane.branches[${index}].sha`);
        return { name, sha: commit, protected: branch.protected === true, identity: branchIdentity(name, commit) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    if (!branchNames.has(defaultBranch))
        fail("ControlPlane.default_branch", `branch "${defaultBranch}" is not present in observed branches`);
    const issueNumbers = new Set();
    const issues = input.issues.map((issue, index) => {
        const number = positiveInteger(issue.number, `ControlPlane.issues[${index}].number`);
        if (issueNumbers.has(number))
            fail(`ControlPlane.issues[${index}].number`, `duplicate issue #${number}`);
        issueNumbers.add(number);
        return {
            number,
            state: issueState(issue.state, `ControlPlane.issues[${index}].state`),
            title: typeof issue.title === "string" ? issue.title : "",
            body: typeof issue.body === "string" ? issue.body : "",
            identity: issueIdentity(number),
        };
    }).sort((a, b) => a.number - b.number);
    const prNumbers = new Set();
    const pullRequests = input.pull_requests.map((pr, index) => {
        const number = positiveInteger(pr.number, `ControlPlane.pull_requests[${index}].number`);
        if (prNumbers.has(number))
            fail(`ControlPlane.pull_requests[${index}].number`, `duplicate PR #${number}`);
        prNumbers.add(number);
        const headRef = text(pr.head?.ref, `ControlPlane.pull_requests[${index}].head.ref`);
        const headSha = sha(pr.head?.sha, `ControlPlane.pull_requests[${index}].head.sha`);
        const headRepository = typeof pr.head?.repo_full_name === "string" ? pr.head.repo_full_name : null;
        return {
            number,
            state: prState(pr.state, `ControlPlane.pull_requests[${index}].state`),
            draft: pr.draft === true,
            merged: pr.merged === true,
            body: typeof pr.body === "string" ? pr.body : "",
            head_ref: headRef,
            head_sha: headSha,
            same_repository: headRepository?.toLowerCase() === repository.toLowerCase(),
            identity: prIdentity(number),
        };
    }).sort((a, b) => a.number - b.number);
    const relations = [];
    for (const issue of issues)
        relations.push(...issueBodyRelations(issue));
    for (const pr of pullRequests) {
        for (const reference of extractLinkedIssueReferences(pr.body, repository)) {
            if (reference.repository.toLowerCase() !== repository.toLowerCase())
                continue;
            relations.push({
                kind: "pr_issue",
                from: pr.identity,
                to: issueIdentity(reference.number),
                provenance: { source: "github_pr_body", owner: pr.identity, detail: `linked issue #${reference.number}` },
            });
        }
        if (pr.same_repository) {
            relations.push({
                kind: "pr_head",
                from: pr.identity,
                to: branchIdentity(pr.head_ref, pr.head_sha),
                provenance: { source: "github_pr_head", owner: pr.identity, detail: `${pr.head_ref}@${pr.head_sha}` },
            });
        }
    }
    relations.sort((a, b) => JSON.stringify([a.kind, a.from, a.to]).localeCompare(JSON.stringify([b.kind, b.from, b.to])));
    const openIssues = new Set(issues.filter((issue) => issue.state === "open").map((issue) => issue.number));
    const reachable = reachableIssues(rootIssueNumber, openIssues, relations);
    const openPrs = pullRequests.filter((pr) => pr.state === "open");
    const reachableIssueIdentities = new Set([...reachable].map(issueIdentity));
    const prIssueTargets = new Map();
    for (const relation of relations) {
        if (relation.kind !== "pr_issue")
            continue;
        const number = Number(relation.from.replace("pr:#", ""));
        if (!prIssueTargets.has(number))
            prIssueTargets.set(number, new Set());
        prIssueTargets.get(number).add(relation.to);
    }
    const ownedOpenPrs = openPrs
        .filter((pr) => [...(prIssueTargets.get(pr.number) || [])].some((target) => reachableIssueIdentities.has(target)))
        .map((pr) => pr.number);
    const ownedOpenPrSet = new Set(ownedOpenPrs);
    const branchByName = new Map(branches.map((branch) => [branch.name, branch]));
    const activeHeadBranches = new Set();
    const movedOrMissing = [];
    for (const pr of openPrs.filter((item) => item.same_repository)) {
        const branch = branchByName.get(pr.head_ref);
        if (!branch || branch.sha !== pr.head_sha) {
            movedOrMissing.push({ pr: pr.number, ref: pr.head_ref, expected_sha: pr.head_sha, observed_sha: branch?.sha || null });
            continue;
        }
        activeHeadBranches.add(branch.name);
    }
    const exactMergedByRef = new Map();
    const exactClosedUnmergedByRef = new Map();
    for (const pr of pullRequests.filter((item) => item.state === "closed" && item.same_repository)) {
        const branch = branchByName.get(pr.head_ref);
        if (!branch || branch.sha !== pr.head_sha)
            continue;
        const target = pr.merged ? exactMergedByRef : exactClosedUnmergedByRef;
        const values = target.get(branch.name) || [];
        values.push(pr.number);
        target.set(branch.name, values);
    }
    const exactMergedResidues = [...exactMergedByRef.entries()]
        .filter(([ref]) => ref !== defaultBranch && !activeHeadBranches.has(ref))
        .map(([ref, prs]) => ({ ref, sha: branchByName.get(ref).sha, prs: [...prs].sort((a, b) => a - b) }))
        .sort((a, b) => a.ref.localeCompare(b.ref));
    const mergedResidueRefs = new Set(exactMergedResidues.map((item) => item.ref));
    const exactClosedUnmergedResidues = [...exactClosedUnmergedByRef.entries()]
        .filter(([ref]) => ref !== defaultBranch && !activeHeadBranches.has(ref) && !mergedResidueRefs.has(ref))
        .map(([ref, prs]) => ({ ref, sha: branchByName.get(ref).sha, prs: [...prs].sort((a, b) => a - b) }))
        .sort((a, b) => a.ref.localeCompare(b.ref));
    const closedUnmergedResidueRefs = new Set(exactClosedUnmergedResidues.map((item) => item.ref));
    return {
        repository,
        default_branch: defaultBranch,
        delete_branch_on_merge: typeof input.delete_branch_on_merge === "boolean" ? input.delete_branch_on_merge : null,
        root_issue_number: rootIssueNumber,
        branches,
        issues: issues.map(({ body: _body, ...issue }) => issue),
        pull_requests: pullRequests.map(({ body: _body, ...pr }) => pr),
        relations,
        derived: {
            reachable_open_issues: [...reachable].sort((a, b) => a - b),
            unreachable_open_issues: [...openIssues].filter((number) => !reachable.has(number)).sort((a, b) => a - b),
            owned_open_prs: ownedOpenPrs.sort((a, b) => a - b),
            unowned_open_prs: openPrs.filter((pr) => !ownedOpenPrSet.has(pr.number)).map((pr) => pr.number).sort((a, b) => a - b),
            active_pr_head_branches: [...activeHeadBranches].sort(),
            moved_or_missing_pr_heads: movedOrMissing.sort((a, b) => a.pr - b.pr),
            persistent_default_branches: [defaultBranch],
            protected_non_default_branches: branches.filter((branch) => branch.protected && branch.name !== defaultBranch).map((branch) => branch.name).sort(),
            exact_merged_pr_head_residues: exactMergedResidues,
            exact_closed_unmerged_pr_head_residues: exactClosedUnmergedResidues,
            unclassified_non_default_refs: branches
                .filter((branch) => branch.name !== defaultBranch
                && !activeHeadBranches.has(branch.name)
                && !mergedResidueRefs.has(branch.name)
                && !closedUnmergedResidueRefs.has(branch.name))
                .map((branch) => branch.name)
                .sort(),
        },
    };
}
export function planMergedResidueDeletions(graph, persistentRefs = []) {
    const persistent = new Set(persistentRefs.map((ref, index) => text(ref, `MergedResidueDeletionPlan.persistent_refs[${index}]`)));
    const active = new Set(graph.derived.active_pr_head_branches);
    const branches = new Map(graph.branches.map((branch) => [branch.name, branch]));
    const candidates = [];
    const excluded = [];
    for (const residue of graph.derived.exact_merged_pr_head_residues) {
        const branch = branches.get(residue.ref);
        if (!branch || branch.sha !== residue.sha) {
            fail("MergedResidueDeletionPlan", `stale merged residue identity for "${residue.ref}": expected ${residue.sha}, observed ${branch?.sha || "missing"}`);
        }
        const candidate = {
            ref: residue.ref,
            expected_sha: residue.sha,
            merged_prs: [...residue.prs].sort((a, b) => a - b),
        };
        const reasons = [];
        if (residue.ref === graph.default_branch)
            reasons.push("default");
        if (active.has(residue.ref))
            reasons.push("active_open_pr_head");
        if (branch.protected)
            reasons.push("protected");
        if (persistent.has(residue.ref))
            reasons.push("persistent");
        if (reasons.length > 0)
            excluded.push({ ...candidate, reasons });
        else
            candidates.push(candidate);
    }
    candidates.sort((a, b) => a.ref.localeCompare(b.ref));
    excluded.sort((a, b) => a.ref.localeCompare(b.ref));
    return {
        contract: "plan_only",
        destructive_authority: false,
        candidates,
        excluded,
    };
}
