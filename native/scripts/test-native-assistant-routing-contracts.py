#!/usr/bin/env python3
"""App-only wiring checks. These are source contracts, not executable Swift tests."""
import argparse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[2])
root = parser.parse_args().source_root
controller = (root / "native/App/Shared/NativeAssistant.swift").read_text()
panel = (root / "native/App/Shared/NativeEditor/NativeAssistantPanel.swift").read_text()
bridge = (root / "native/ReelKit/Sources/ReelKit/AgentBridge.swift").read_text()

assert "NativeAssistantRoutingPolicy.availableModels(providers:" in controller
assert "NativeAssistantRoutingPolicy.initialProvider(" in controller
assert "chatGPTSupported: NativeChatGPT.supported" in controller
assert "NativeAssistantRoutingPolicy.eligibleAutoModels(modelOptions, agent: agent)" in controller
assert "NativeAssistantRoutingPolicy.eligibleAutoModels(options, agent: nextAgent)" in controller
assert "savedModelReferences(keys: enabledModelKeys, defaultModels: eligibleAutoModels)" in controller
assert controller.count("savedAutoModelReferences.map") == 2, "both flat and nested snapshots must preserve saved refs"
assert controller.count("if let issue = manualReadinessReason") == 2, "both status acceptance and configuration refresh must validate readiness"
assert "text.count <= inputCharacterLimit" in controller
assert "model.assistantDraft.count > assistant.inputCharacterLimit" in panel
assert "func refreshStatus(refresh: Bool = false, access: NativeCredentialReadAccess = .passive)" in controller
assert '$0.name == "refresh" && $0.value == "1"' in controller
assert "await refreshStatus(refresh: refresh); return snapshot" in controller
assert "bridgeConfiguration(access: access)).status(refresh: refresh)" in controller
assert "bridge.status(refresh: true)" in controller, "pairing must check fresh account status"
assert "configuration: configuration).status(refresh: true)" in controller, "staged companion save must check fresh status"
assert "await assistant.refreshStatus(refresh: true)" in controller
assert "await assistant.refreshStatus(refresh: true)" in panel
assert 'status(refresh: Bool = false)' in bridge
assert 'refresh ? "/v1/status?refresh=1" : "/v1/status"' in bridge
assert "guard statusID == id, connectionGeneration == generation, !Task.isCancelled else { return }" in controller
assert 'let selectedProvider = provider, selectedModel = routingMode == "manual" ? sharing.scope.models[0].model : model, selectedAgent = agent' in controller
assert "accountStatusVerified = false; sharingConsentVersion = 0; routingSupported = false; providers = []; catalogs = []" in controller
model_controls = panel[panel.index("private func modelControls(short: Bool)"):panel.index("private var routeSummary")]
assert "let label = short ? NativeAssistantRoutingPolicy.compactRoutingLabel(mode: assistant.routingMode, provider: assistant.provider) : assistant.routingLabel" in model_controls, "a phone's model chip names only Auto or the provider"
assert '.accessibilityLabel("Assistant model, \\(assistant.routingLabel)")' in model_controls, "VoiceOver still reads the full route"
assert "modelControls(short: width < 420 || compactTouch)" in panel, "a compact-width phone row uses the short label"
assert "modelControls(short: dynamicTypeSize >= .accessibility3 || compactTouch)" in panel, "and so does a phone's stacked row at accessibility sizes"
assert 'restoreAssistantChange(change.before, expected: change.after, line: "Undo assistant change", historyMove: change.kind == "history")' in controller, "an assistant's history move is undone as a history move"
assert "private var compactTouch: Bool {\n        #if os(iOS)\n        horizontalSizeClass == .compact\n        #else\n        false" in panel, "only iOS has a size class"
print("PASS: 29 app-only source contracts. Foundation policy and transport XCTest cases are unexecuted until the root compiler gate.")
