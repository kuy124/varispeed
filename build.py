"""Build both browsers: python build.py (Python 3.9+, no dependencies)."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent


def build(output):
    base = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    files = {
        'popup.html', 'popup.js', 'content.js', 'main.js', 'LICENSE',
        *base['icons'].values(),
    }
    for browser in ('chrome', 'firefox'):
        manifest = dict(base)
        if browser == 'chrome':
            manifest['minimum_chrome_version'] = '111'
        else:
            manifest['browser_specific_settings'] = {
                'gecko': {
                    'id': 'varispeed@kuy124',
                    'strict_min_version': '140.0',
                    'data_collection_permissions': {'required': ['none']},
                },
            }
        folder = output / browser
        folder.mkdir(parents=True, exist_ok=True)
        archive = output / f"varispeed-{browser}-{base['version']}.zip"
        with ZipFile(archive, 'w', ZIP_DEFLATED) as package:
            text = json.dumps(manifest, indent=2) + '\n'
            (folder / 'manifest.json').write_bytes(text.encode('utf-8'))
            package.writestr('manifest.json', text)
            for name in sorted(files):
                data = (ROOT / name).read_bytes()
                (folder / name).write_bytes(data)
                package.writestr(name, data)
        print(archive)
        if browser == 'firefox':
            xpi = archive.with_suffix('.xpi')
            xpi.write_bytes(archive.read_bytes())
            print(xpi)


if __name__ == '__main__':
    build(ROOT / 'dist')
