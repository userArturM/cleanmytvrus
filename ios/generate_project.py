#!/usr/bin/env python3
"""Generate the Xcode project using only Python and macOS's built-in sips."""
import json, pathlib, plistlib, shutil, subprocess
root = pathlib.Path(__file__).resolve().parent
assets = root/'Bitora/Assets.xcassets'
assets.mkdir(exist_ok=True)
(assets/'Contents.json').write_text(json.dumps({'info': {'author':'xcode','version':1}}))
for folder, filename, entry in [('AppIcon.appiconset','icon.png',{'idiom':'universal','platform':'ios','size':'1024x1024'}),('Brand.imageset','brand.png',{'idiom':'universal'})]:
    target = assets/folder; target.mkdir(exist_ok=True)
    shutil.copy(root.parent/'build/icon.png', target/filename)
    if folder.startswith('AppIcon'):
        subprocess.run(['sips','-z','1024','1024',str(target/filename)],check=True)
    (target/'Contents.json').write_text(json.dumps({'images':[dict(entry,filename=filename)],'info':{'author':'xcode','version':1}}))
info = {'CFBundleDisplayName':'Bitora Android TV','CFBundleName':'Bitora','CFBundleIdentifier':'$(PRODUCT_BUNDLE_IDENTIFIER)',
        'CFBundleExecutable':'$(EXECUTABLE_NAME)','CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.1.0','CFBundleVersion':'1',
        'LSRequiresIPhoneOS':True,'NSLocalNetworkUsageDescription':'Bitora подключается к вашему Android TV по Wi-Fi для управления телевизором.',
        'UILaunchScreen':{},'UIApplicationSceneManifest':{'UIApplicationSupportsMultipleScenes':False},
        'UISupportedInterfaceOrientations':['UIInterfaceOrientationPortrait','UIInterfaceOrientationLandscapeLeft','UIInterfaceOrientationLandscapeRight'],
        'ITSAppUsesNonExemptEncryption':False}
with (root/'Bitora/Info.plist').open('wb') as f: plistlib.dump(info,f)
objects = {}
def obj(key, isa, **fields):
    ident = key.zfill(24); objects[ident] = dict(isa=isa, **fields); return ident
sources=[]; children=[]
for i, file in enumerate(['ADB.swift','BitoraApp.swift','Assets.xcassets']):
    ref=obj(str(10+i),'PBXFileReference',lastKnownFileType='folder.assetcatalog' if i==2 else 'sourcecode.swift',path=file,sourceTree='<group>')
    children.append(ref)
    sources.append(obj(str(20+i),'PBXBuildFile',fileRef=ref))
product=obj('30','PBXFileReference',explicitFileType='wrapper.application',path='Bitora.app',sourceTree='BUILT_PRODUCTS_DIR')
group=obj('31','PBXGroup',children=children,path='Bitora',sourceTree='<group>')
products=obj('32','PBXGroup',children=[product],name='Products',sourceTree='<group>')
main=obj('33','PBXGroup',children=[group,products],sourceTree='<group>')
src=obj('34','PBXSourcesBuildPhase',buildActionMask=2147483647,files=sources[:2],runOnlyForDeploymentPostprocessing=0)
res=obj('35','PBXResourcesBuildPhase',buildActionMask=2147483647,files=sources[2:],runOnlyForDeploymentPostprocessing=0)
settings={'SDKROOT':'iphoneos','IPHONEOS_DEPLOYMENT_TARGET':'16.0','SWIFT_VERSION':'5.0','TARGETED_DEVICE_FAMILY':'1,2',
 'PRODUCT_BUNDLE_IDENTIFIER':'io.github.userarturm.bitora.ios','PRODUCT_NAME':'Bitora','INFOPLIST_FILE':'Bitora/Info.plist',
 'ASSETCATALOG_COMPILER_APPICON_NAME':'AppIcon','CODE_SIGNING_ALLOWED':'NO','ENABLE_USER_SCRIPT_SANDBOXING':'YES',
 'SWIFT_OPTIMIZATION_LEVEL':'-O','CLANG_ENABLE_MODULES':'YES','LD_RUNPATH_SEARCH_PATHS':'$(inherited) @executable_path/Frameworks'}
configs=[obj(str(40+i),'XCBuildConfiguration',buildSettings=settings,name=name) for i,name in enumerate(['Debug','Release'])]
cl=obj('42','XCConfigurationList',buildConfigurations=configs,defaultConfigurationIsVisible=0,defaultConfigurationName='Release')
pc=[obj(str(43+i),'XCBuildConfiguration',buildSettings={},name=name) for i,name in enumerate(['Debug','Release'])]
pcl=obj('45','XCConfigurationList',buildConfigurations=pc,defaultConfigurationIsVisible=0,defaultConfigurationName='Release')
target=obj('50','PBXNativeTarget',buildConfigurationList=cl,buildPhases=[src,res],buildRules=[],dependencies=[],name='Bitora',productName='Bitora',productReference=product,productType='com.apple.product-type.application')
project=obj('60','PBXProject',attributes={'LastUpgradeCheck':'1640'},buildConfigurationList=pcl,compatibilityVersion='Xcode 14.0',developmentRegion='ru',knownRegions=['ru','en','Base'],mainGroup=main,productRefGroup=products,projectDirPath='',projectRoot='',targets=[target])
def encode(value):
    if isinstance(value, dict): return '{\n' + ''.join(json.dumps(k)+' = '+encode(v)+';\n' for k,v in value.items()) + '}'
    if isinstance(value,list): return '('+','.join(encode(v) for v in value)+')'
    return json.dumps(value,ensure_ascii=False)
proj=root/'Bitora.xcodeproj'; proj.mkdir(exist_ok=True)
(proj/'project.pbxproj').write_text('// !$*UTF8*$!\n'+encode(dict(archiveVersion=1,classes={},objectVersion=56,objects=objects,rootObject=project)))
schemes=proj/'xcshareddata/xcschemes'; schemes.mkdir(parents=True,exist_ok=True)
ref=f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="Bitora.app" BlueprintName="Bitora" ReferencedContainer="container:Bitora.xcodeproj"/>'
(schemes/'Bitora.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1640" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction><LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></LaunchAction><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>''')
