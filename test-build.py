"""Run: python test-build.py"""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile

from build import ROOT, build

with TemporaryDirectory() as temp:
    output = Path(temp)
    build(output)
    base = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    firefox = f"varispeed-firefox-{base['version']}"
    assert (output / f'{firefox}.xpi').read_bytes() == (output / f'{firefox}.zip').read_bytes()
    for browser in ('chrome', 'firefox'):
        with ZipFile(output / f"varispeed-{browser}-{base['version']}.zip") as package:
            assert package.testzip() is None
            manifest = json.loads(package.read('manifest.json'))
            assert manifest['manifest_version'] == 3
            assert manifest['content_scripts'] == base['content_scripts']
            assert manifest['permissions'] == base['permissions']
            if browser == 'firefox':
                gecko = manifest['browser_specific_settings']['gecko']
                assert gecko['id'] == 'varispeed@kuy124'
                assert gecko['strict_min_version'] == '140.0'
                assert gecko['data_collection_permissions']['required'] == ['none']
                assert 'minimum_chrome_version' not in manifest
            else:
                assert manifest['minimum_chrome_version'] == '111'
                assert 'browser_specific_settings' not in manifest
            for name in package.namelist():
                assert package.read(name) == (output / browser / name).read_bytes()
                if name != 'manifest.json':
                    assert package.read(name) == (ROOT / name).read_bytes()
            required = {'popup.html', 'popup.js', 'LICENSE', *manifest['icons'].values()}
            for script in manifest['content_scripts']:
                required.update(script['js'])
            assert set(package.namelist()) == required | {'manifest.json'}
print('ok')
