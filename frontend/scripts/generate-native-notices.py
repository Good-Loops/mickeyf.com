import os, re, json, zipfile, hashlib, urllib.request, xml.etree.ElementTree as ET
from pathlib import Path
root=Path(__file__).resolve().parents[2]; cache=Path(os.environ['USERPROFILE'])/'.gradle/caches/modules-2/files-2.1'
lock=(root/'frontend/android/app/gradle.lockfile').read_text(encoding='utf-8')
coords=sorted(l.split('=')[0] for l in lock.splitlines() if '=releaseRuntimeClasspath' in l or ('=' in l and 'releaseRuntimeClasspath' in l.split('=',1)[1].split(',')))
print('coordinates',len(coords))
entries={}; archives=[]; rows=[]
for coord in coords:
 group,artifact,version=coord.split(':'); folder=cache/group/artifact/version
 poms=list(folder.rglob('*.pom'))
 if len(poms)!=1: raise ValueError(f'Need exactly one cached POM: {coord}: {poms}')
 tree=ET.parse(poms[0]); ns={'p':'http://maven.apache.org/POM/4.0.0'}
 licenses=[n.text.strip() for n in tree.findall('./p:licenses/p:license/p:name',ns) if n.text]
 if coord=='com.google.guava:listenablefuture:1.0': licenses=['Apache License 2.0 (from guava-parent 26.0-android)']
 if len(licenses)!=1: raise ValueError(f'Unexpected license {coord}: {licenses}')
 rows.append(f'{coord} — {licenses[0]}')
 aars=list(folder.rglob('*.aar'))
 if len(aars)>1: raise ValueError(f'Multiple AARs: {coord}')
 if aars:
  with zipfile.ZipFile(aars[0]) as z:
   if 'third_party_licenses.json' not in z.namelist(): continue
   data=z.read('third_party_licenses.txt'); index=json.loads(z.read('third_party_licenses.json'))
   archives.append({'coordinate':coord,'aar_sha256':hashlib.sha256(aars[0].read_bytes()).hexdigest(),'notice_count':len(index)})
   for title,location in index.items():
    chunk=data[location['start']:location['start']+location['length']]; chunk.decode('utf-8')
    key=(title,hashlib.sha256(chunk).hexdigest())
    if key not in entries: entries[key]=[chunk,[]]
    entries[key][1].append(coord)
repos=[('AppAuth 3.0.0','openid/AppAuth-iOS','3.0.0'),('AppCheckCore 11.3.2','google/app-check','CocoaPods-11.3.2'),('GoogleSignIn 10.0.0','google/GoogleSignIn-iOS','10.0.0'),('GoogleUtilities 8.1.4','google/GoogleUtilities','CocoaPods-8.1.4'),('GTMAppAuth 6.0.0','google/GTMAppAuth','6.0.0'),('GTMSessionFetcher 5.3.1','google/gtm-session-fetcher','v5.3.1'),('PromisesObjC and PromisesSwift 2.4.1','google/promises','2.4.1'),('RecaptchaInterop 101.0.0','google/interop-ios-for-google-sdks','CocoaPods-101.0.0')]
parts=['Ludolume — native third-party notices\n\nThese notices cover the native dependency versions locked for the Android release and iOS app. They supplement the main third-party notices. Not every dependency is necessarily included in every platform build. Google Play components may be subject to Android SDK or Play Core terms rather than open-source licenses.\n\nANDROID RELEASE RUNTIME DEPENDENCIES\n\n'+'\n'.join(rows)+'\n\nThe Android SDK terms are at https://developer.android.com/studio/terms and the Play Core terms are at https://developer.android.com/guide/playcore/license.\n\nIOS COCOAPODS\n\nCapacitor 8.5.1 and CapacitorCordova 8.5.1 are covered in the main third-party notices. The following locked CocoaPods specify Apache 2.0; their source license files are included below.\n']
licenses={}
for names,repo,tag in repos:
 url=f'https://raw.githubusercontent.com/{repo}/{tag}/LICENSE'
 blob=urllib.request.urlopen(url,timeout=20).read(); key=hashlib.sha256(blob).hexdigest()
 if key not in licenses: licenses[key]=[blob,[]]
 licenses[key][1].append(f'{names}: {url}')
for blob,sources in licenses.values():
 parts.append('\n'+'='*72+'\n'+'\n'.join(sources)+'\n'+'='*72+'\n'+blob.decode('utf-8')+'\n')
parts.append('\n'+'='*72+'\nGOOGLE AND PLAY ANDROID SDK EMBEDDED THIRD-PARTY NOTICES\nThese exact notices are extracted from the SDK archives listed for each entry. Identical title/text pairs shared by archives appear once.\n')
for (title,digest),(chunk,sources) in sorted(entries.items()):
 parts.append('\n'+'='*72+'\n'+title+'\nArchives: '+', '.join(sources)+'\n'+'='*72+'\n'+chunk.decode('utf-8')+'\n')
output=''.join(parts).encode('utf-8')
(root/'frontend/public/native-third-party-notices.txt').write_bytes(output)
manifest={'android_lockfile_sha256':hashlib.sha256((root/'frontend/android/app/gradle.lockfile').read_bytes().replace(b'\r\n',b'\n')).hexdigest(),'ios_lockfile_sha256':hashlib.sha256((root/'frontend/ios/App/Podfile.lock').read_bytes().replace(b'\r\n',b'\n')).hexdigest(),'android_archives':archives,'unique_notice_entries':len(entries),'notices_sha256':hashlib.sha256(output).hexdigest()}
(root/'frontend/native-notices-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print('aar count',len(archives),'notices',len(entries),'bytes',len(output))
