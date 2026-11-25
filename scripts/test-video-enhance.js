// Unit tests for src/main/video-enhance.js: GPU capability detection, driver parsing, crash guard.
// Usage: node scripts/test-video-enhance.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const ve = require("../src/main/video-enhance");

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "ok  " : "FAIL"} - ${name}${detail ? "  (" + detail + ")" : ""}`);
const hw = { gpu_compositing: "enabled", video_decode: "enabled" };
const gpu = (vendorId, renderer, driverVersion = "32.0.16.1088", active = true) => ({
  gpuDevice: [{ active, vendorId, deviceId: 1, driverVersion }],
  auxAttributes: { glRenderer: renderer }
});
const detect = (gpuInfo, featureStatus = hw, platform = "win32") => ve.detectEnhanceSupport({ platform, gpuInfo, featureStatus });

// Driver versions
check("driver 32.0.16.1088 -> 610.88", ve.nvidiaDriverVersion("32.0.16.1088") === 610.88);
check("driver 31.0.15.3118 -> 531.18", ve.nvidiaDriverVersion("31.0.15.3118") === 531.18);
check("driver 30.0.14.7212 -> 472.12", ve.nvidiaDriverVersion("30.0.14.7212") === 472.12);
check("bad driver string -> null", ve.nvidiaDriverVersion("abc") === null && ve.nvidiaDriverVersion("") === null);
check("gpu name from ANGLE string", ve.gpuNameFromRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x000024C7) Direct3D11 vs_5_0 ps_5_0, D3D11-32.0.16.1088)") === "NVIDIA GeForce RTX 3060");

// Detection
const rtx = detect(gpu(0x10de, "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x000024C7) Direct3D11 vs_5_0 ps_5_0, D3D11-32.0.16.1088)"));
check("RTX 3060 + new driver -> NVIDIA VSR", rtx.supported && rtx.tech === "nvidia-vsr" && rtx.driver === 610.88 && rtx.gpu === "NVIDIA GeForce RTX 3060");
const rtx40 = detect(gpu(0x10de, "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.5222)", "31.0.15.5222"));
check("RTX 4070 Laptop -> supported", rtx40.supported);
const quadro = detect(gpu(0x10de, "ANGLE (NVIDIA, NVIDIA RTX A2000 (0x00002531) Direct3D11 vs_5_0 ps_5_0, D3D11-32.0.15.6094)", "32.0.15.6094"));
check("RTX A2000 workstation -> supported", quadro.supported);
const oldDriver = detect(gpu(0x10de, "ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 (0x00001F08) Direct3D11 vs_5_0 ps_5_0, D3D11-30.0.15.1179)", "30.0.15.1179"));
check("RTX 2060 + driver 511.79 -> unsupported (driver)", !oldDriver.supported && /Driver NVIDIA 511\.79/.test(oldDriver.reason), oldDriver.reason);
const gtx = detect(gpu(0x10de, "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER (0x000021C4) Direct3D11 vs_5_0 ps_5_0, D3D11-32.0.16.1088)"));
check("GTX 1660 -> unsupported (needs RTX)", !gtx.supported && /RTX/.test(gtx.reason));
const arc = detect(gpu(0x8086, "ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.101.5186)", "31.0.101.5186"));
check("Intel Arc -> Intel VSR (experimental)", arc.supported && arc.tech === "intel-vsr");
const xe = detect(gpu(0x8086, "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.101.4502)", "31.0.101.4502"));
check("Intel Iris Xe -> supported", xe.supported);
const uhd = detect(gpu(0x8086, "ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.101.2111)", "31.0.101.2111"));
check("Intel UHD 630 -> unsupported", !uhd.supported);
const amd = detect(gpu(0x1002, "ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.24027.1012)", "31.0.24027.1012"));
check("AMD -> unsupported with hint", !amd.supported && /AMD/.test(amd.reason));
check("software rendering -> unsupported", !detect(gpu(0x10de, "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)"), { gpu_compositing: "disabled_software", video_decode: "disabled_software" }).supported);
check("video decode off -> unsupported", !detect(gpu(0x10de, "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)"), { gpu_compositing: "enabled", video_decode: "disabled_software" }).supported);
check("no GPU device -> unsupported", !detect({ gpuDevice: [{ active: false, vendorId: 0 }] }).supported);
check("macOS -> unsupported", !detect(gpu(0x10de, "RTX"), hw, "darwin").supported);
check("hybrid laptop uses the active GPU", detect({ gpuDevice: [{ active: false, vendorId: 0x8086, driverVersion: "31.0.101.2111" }, { active: true, vendorId: 0x10de, driverVersion: "32.0.16.1088" }], auxAttributes: { glRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU (0x000025A2) Direct3D11 vs_5_0 ps_5_0)" } }).supported);

// Crash guard / launch plan
const fresh = ve.planLaunch({ settingOn: true, guard: { startupPending: false, disabledReason: "" } });
check("normal launch with setting on -> enhance on, pending set", fresh.enhanceOnLaunch && fresh.guard.startupPending && !fresh.disabledNow);
const crashed = ve.planLaunch({ settingOn: true, guard: { startupPending: true, disabledReason: "" } });
check("previous launch never became stable -> start without enhancement", !crashed.enhanceOnLaunch && crashed.disabledNow && crashed.guard.disabledReason === "startup-crash" && !crashed.guard.startupPending);
const off = ve.planLaunch({ settingOn: false, guard: { startupPending: true, disabledReason: "gpu-crash" } });
check("setting off -> no enhancement, reason kept", !off.enhanceOnLaunch && !off.disabledNow && off.guard.disabledReason === "gpu-crash" && !off.guard.startupPending);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "visubly-guard-"));
const file = path.join(dir, "gpu-guard.json");
check("missing guard file reads as clean", JSON.stringify(ve.readGuard(file)) === JSON.stringify({ startupPending: false, disabledReason: "" }));
ve.writeGuard(file, { startupPending: true, disabledReason: "stutter" });
check("guard round-trips", ve.readGuard(file).startupPending === true && ve.readGuard(file).disabledReason === "stutter");
fs.writeFileSync(file, "{broken");
check("corrupt guard file reads as clean", ve.readGuard(file).startupPending === false);
fs.rmSync(dir, { recursive: true, force: true });
check("feature switches", ve.FEATURES_ON.includes("NvidiaVpSuperResolution") && ve.FEATURES_OFF.includes("NvidiaVpTrueHDR"));

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `${failed} FAILED` : `ALL PASSED (${results.length})`);
process.exit(failed ? 1 : 0);
