import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "js" / "logbrew-react-native"


class ReactNativeFatalHandoffContractTests(unittest.TestCase):
    def test_fatal_replay_has_one_focused_platform_neutral_owner(self) -> None:
        installer = (PACKAGE_ROOT / "global-errors.cjs").read_text(encoding="utf-8")
        fatal_replay_path = PACKAGE_ROOT / "fatal-replay.cjs"

        self.assertTrue(fatal_replay_path.is_file())
        fatal_replay = fatal_replay_path.read_text(encoding="utf-8")
        self.assertIn('require("./fatal-replay.cjs")', installer)
        self.assertIn("createFatalController", fatal_replay)
        self.assertNotIn("function createFatalController", installer)
        self.assertNotIn("function replayPendingFatal", installer)
        self.assertLess(len(installer.splitlines()), 600)
        self.assertLess(len(fatal_replay.splitlines()), 600)

    def test_package_tracks_the_complete_autolinked_native_surface(self) -> None:
        manifest = json.loads((PACKAGE_ROOT / "package.json").read_text(encoding="utf-8"))

        self.assertEqual(
            {
                "name": "LogBrewReactNativeSpec",
                "type": "modules",
                "jsSrcsDir": "src",
                "android": {"javaPackageName": "co.logbrew.reactnative"},
            },
            manifest["codegenConfig"],
        )
        packaged = set(manifest["files"])
        self.assertTrue(
            {
                "LogBrewReactNative.podspec",
                "fatal-replay.cjs",
                "android/build.gradle",
                "android/src/main",
                "android/src/oldarch",
                "android/src/newarch",
                "ios/LBRNFatalRecordStore.h",
                "ios/LBRNFatalRecordStore.m",
                "ios/LBRNFatalStoreModule.h",
                "ios/LBRNFatalStoreModule.mm",
                "react-native.config.js",
                "src",
            }.issubset(packaged)
        )
        self.assertEqual(
            {
                "types": "./global-errors.d.ts",
                "default": "./global-errors.native.js",
            },
            manifest["exports"]["./global-errors"]["react-native"],
        )
        self.assertEqual(
            {
                "types": "./index.native.d.ts",
                "default": "./index.native.js",
            },
            manifest["exports"]["."]["react-native"],
        )
        for relative_path in (
            "LogBrewReactNative.podspec",
            "fatal-replay.cjs",
            "global-errors.native.js",
            "index.native.d.ts",
            "react-native.config.js",
            "src/NativeLogBrewFatalStore.ts",
            "ios/LBRNFatalRecordStore.h",
            "ios/LBRNFatalRecordStore.m",
            "ios/LBRNFatalStoreModule.h",
            "ios/LBRNFatalStoreModule.mm",
            "android/build.gradle",
            "android/src/main/AndroidManifest.xml",
            "android/src/main/java/co/logbrew/reactnative/FatalRecordStore.java",
            "android/src/main/java/co/logbrew/reactnative/FatalStoreModuleImpl.java",
            "android/src/main/java/co/logbrew/reactnative/LogBrewReactNativePackage.java",
            "android/src/oldarch/java/co/logbrew/reactnative/FatalStoreModule.java",
            "android/src/newarch/java/co/logbrew/reactnative/FatalStoreModule.java",
        ):
            self.assertTrue((PACKAGE_ROOT / relative_path).is_file(), relative_path)

    def test_pack_dry_run_owns_every_autolink_and_conditional_export_file(self) -> None:
        completed = subprocess.run(
            ["npm", "pack", "--dry-run", "--json"],
            cwd=PACKAGE_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        packed = {entry["path"] for entry in json.loads(completed.stdout)[0]["files"]}
        required = {
            "LogBrewReactNative.podspec",
            "fatal-replay.cjs",
            "global-errors.native.js",
            "index.native.d.ts",
            "react-native.config.js",
            "src/NativeLogBrewFatalStore.ts",
            "ios/LBRNFatalRecordStore.h",
            "ios/LBRNFatalRecordStore.m",
            "ios/LBRNFatalStoreModule.h",
            "ios/LBRNFatalStoreModule.mm",
            "android/build.gradle",
            "android/src/main/AndroidManifest.xml",
            "android/src/main/java/co/logbrew/reactnative/FatalRecordStore.java",
            "android/src/main/java/co/logbrew/reactnative/FatalStoreModuleImpl.java",
            "android/src/main/java/co/logbrew/reactnative/LogBrewReactNativePackage.java",
            "android/src/oldarch/java/co/logbrew/reactnative/FatalStoreModule.java",
            "android/src/newarch/java/co/logbrew/reactnative/FatalStoreModule.java",
        }
        self.assertEqual(set(), required - packed)

    def test_react_native_config_autolinks_ios_and_android(self) -> None:
        completed = subprocess.run(
            [
                "node",
                "--input-type=module",
                "-e",
                (
                    "const value=(await import(process.argv[1])).default;"
                    "process.stdout.write(JSON.stringify(value));"
                ),
                (PACKAGE_ROOT / "react-native.config.js").as_uri(),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        config = json.loads(completed.stdout)

        self.assertEqual({}, config["dependency"]["platforms"]["ios"])
        self.assertEqual(
            {
                "packageImportPath": (
                    "import co.logbrew.reactnative.LogBrewReactNativePackage;"
                ),
                "packageInstance": "new LogBrewReactNativePackage()",
            },
            config["dependency"]["platforms"]["android"],
        )

    def test_react_native_condition_injects_owned_sync_module_with_stub_runtime(self) -> None:
        with tempfile.TemporaryDirectory(prefix="logbrew-rn-condition-") as root_value:
            root = Path(root_value)
            modules = root / "node_modules"
            logbrew = modules / "@logbrew"
            logbrew.mkdir(parents=True)
            os.symlink(PACKAGE_ROOT, logbrew / "react-native", target_is_directory=True)
            os.symlink(
                ROOT / "js" / "logbrew-js",
                logbrew / "sdk",
                target_is_directory=True,
            )
            react = modules / "react"
            react.mkdir()
            (react / "package.json").write_text(
                json.dumps(
                    {
                        "name": "react",
                        "version": "18.0.0",
                        "type": "module",
                        "exports": {
                            "import": "./index.js",
                            "require": "./index.cjs",
                        },
                    }
                ),
                encoding="utf-8",
            )
            (react / "index.js").write_text(
                (
                    "export const createContext=(value)=>({_currentValue:value,"
                    "Provider(){},Consumer(){}});"
                    "export const createElement=(type,props,...children)=>"
                    "({type,props:{...(props||{}),children}});"
                    "export default {createContext,createElement};"
                ),
                encoding="utf-8",
            )
            (react / "index.cjs").write_text(
                (
                    "const createContext=(value)=>({_currentValue:value,"
                    "Provider(){},Consumer(){}});"
                    "const createElement=(type,props,...children)=>"
                    "({type,props:{...(props||{}),children}});"
                    "module.exports={createContext,createElement};"
                ),
                encoding="utf-8",
            )
            react_native = modules / "react-native"
            react_native.mkdir()
            (react_native / "package.json").write_text(
                json.dumps(
                    {
                        "name": "react-native",
                        "version": "0.76.0",
                        "type": "module",
                        "exports": "./index.js",
                    }
                ),
                encoding="utf-8",
            )
            (react_native / "index.js").write_text(
                (
                    "const store=globalThis.__logBrewFatalStore;"
                    "export const NativeModules={LogBrewFatalStore:store};"
                    "export const TurboModuleRegistry={get(name){"
                    "return name==='LogBrewFatalStore'?store:null;}};"
                    "export const AppState={currentState:'active',addEventListener(){"
                    "return {remove(){}};}};"
                    "export const Platform={OS:'android'};"
                ),
                encoding="utf-8",
            )
            script = """
const record={
  corruptRecords:0,
  droppedRecords:0,
  errorName:"TypeError",
  id:"evt_rn_fatal_condition",
  schemaVersion:1,
  stackFrames:[],
  timestamp:"2026-07-25T12:00:00.000Z"
};
let pending=record;
globalThis.__logBrewFatalStore={
  writeFatalRecord(){return {status:"dropped_pending"};},
  readFatalRecord(){return pending?{record:pending,status:"pending"}:{status:"empty"};},
  acknowledgeFatalRecord(id){
    if (!pending || pending.id!==id) return {status:"id_mismatch"};
    pending=undefined;
    return {recordId:id,status:"acknowledged"};
  },
  discardFatalRecord(){return {status:"empty"};}
};
let handler=()=>{};
const errorUtils={
  getGlobalHandler(){return handler;},
  setGlobalHandler(value){handler=value;}
};
const issues=[];
const client={
  droppedEvents(){return 0;},
  issue(id,timestamp,attributes){issues.push({attributes,id,timestamp});},
  pendingEvents(){return issues.length;}
};
const subpath=await import("@logbrew/react-native/global-errors");
const root=await import("@logbrew/react-native");
const installation=subpath.installLogBrewReactNativeGlobalErrorHandler({
  client,
  errorUtils
});
if (issues.length!==1 || pending!==undefined) throw new Error("native store not injected");
if (installation.fatalHealth().lastOutcome!=="acknowledged") {
  throw new Error("fatal replay not acknowledged");
}
if (typeof root.installLogBrewReactNativeGlobalErrorHandler!=="function") {
  throw new Error("root native convenience missing");
}
"""
            subprocess.run(
                [
                    "node",
                    "--conditions=react-native",
                    "--preserve-symlinks",
                    "--input-type=module",
                    "-e",
                    script,
                ],
                cwd=root,
                check=True,
                capture_output=True,
                text=True,
            )

    def test_old_and_new_architecture_adapters_expose_all_sync_methods(self) -> None:
        method_names = (
            "writeFatalRecord",
            "readFatalRecord",
            "acknowledgeFatalRecord",
            "discardFatalRecord",
        )
        podspec = (PACKAGE_ROOT / "LogBrewReactNative.podspec").read_text(encoding="utf-8")
        gradle = (PACKAGE_ROOT / "android" / "build.gradle").read_text(encoding="utf-8")
        ios_module = (
            PACKAGE_ROOT / "ios" / "LBRNFatalStoreModule.mm"
        ).read_text(encoding="utf-8")
        old_arch = (
            PACKAGE_ROOT
            / "android"
            / "src"
            / "oldarch"
            / "java"
            / "co"
            / "logbrew"
            / "reactnative"
            / "FatalStoreModule.java"
        ).read_text(encoding="utf-8")
        new_arch = (
            PACKAGE_ROOT
            / "android"
            / "src"
            / "newarch"
            / "java"
            / "co"
            / "logbrew"
            / "reactnative"
            / "FatalStoreModule.java"
        ).read_text(encoding="utf-8")

        self.assertIn("ios/**/*.{h,m,mm}", podspec)
        self.assertIn("React-Core", podspec)
        android_module = (
            PACKAGE_ROOT
            / "android"
            / "src"
            / "main"
            / "java"
            / "co"
            / "logbrew"
            / "reactnative"
            / "FatalStoreModuleImpl.java"
        ).read_text(encoding="utf-8")
        archive_term = "Back" + "up"
        self.assertIn(f"getNo{archive_term}FilesDir()", android_module)
        self.assertIn(f"NSURLIsExcludedFrom{archive_term}Key", ios_module)
        self.assertIn("src/oldarch", gradle)
        self.assertIn("src/newarch", gradle)
        self.assertIn("com.facebook.react:react-android", gradle)
        self.assertIn("ReactContextBaseJavaModule", old_arch)
        self.assertIn("NativeLogBrewFatalStoreSpec", new_arch)
        self.assertIn("NativeLogBrewFatalStoreSpecJSI", ios_module)
        for method_name in method_names:
            self.assertIn(
                f"RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD({method_name}",
                ios_module,
            )
            self.assertIn(
                f"@ReactMethod(isBlockingSynchronousMethod = true)\n"
                f"  public WritableMap {method_name}",
                old_arch,
            )
            self.assertIn(f"public WritableMap {method_name}", new_arch)

    def test_esm_cjs_and_typescript_publish_the_same_additive_api(self) -> None:
        esm = (PACKAGE_ROOT / "global-errors.js").read_text(encoding="utf-8")
        native = (PACKAGE_ROOT / "global-errors.native.js").read_text(encoding="utf-8")
        cjs = (PACKAGE_ROOT / "global-errors.cjs").read_text(encoding="utf-8")
        declaration = (PACKAGE_ROOT / "global-errors.d.ts").read_text(encoding="utf-8")
        commonjs_declaration = (
            PACKAGE_ROOT / "global-errors.d.cts"
        ).read_text(encoding="utf-8")

        self.assertEqual(declaration, commonjs_declaration)
        self.assertIn("installLogBrewReactNativeGlobalErrorHandler", esm)
        self.assertIn("installLogBrewReactNativeGlobalErrorHandler", cjs)
        self.assertIn("installLogBrewReactNativeGlobalErrorHandler", native)
        self.assertNotIn('require("react-native")', cjs)
        self.assertNotIn('from "react-native"', cjs)
        for public_name in (
            "ReactNativeFatalStoreLike",
            "ReactNativeFatalReplayHealth",
            "fatalHealth(): ReactNativeFatalReplayHealth",
            "discardPendingFatalRecord(): boolean",
        ):
            self.assertIn(public_name, declaration)


if __name__ == "__main__":
    unittest.main()
