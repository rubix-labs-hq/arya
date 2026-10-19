import json, subprocess, os
from pathlib import Path
root=Path(__file__).resolve().parents[2]
assets=root/'site/assets/brand'
env=dict(os.environ,SWIFT_MODULECACHE_PATH='/private/tmp/arya-swift-modulecache',CLANG_MODULE_CACHE_PATH='/private/tmp/arya-swift-modulecache')
def outline(text,size=32,weight=500,italic=False):
    font=root/('site/assets/fonts/newsreader-italic.ttf' if italic else 'site/assets/fonts/manrope.ttf')
    return json.loads(subprocess.check_output(['swift',str(root/'site/scripts/outline-type.swift'),str(font),text,str(size),str(weight)],env=env))
def text_path(text,x,y,size=32,color='#f2f0e9',weight=500,italic=False):
    data=outline(text,size,weight,italic)
    return f'<path fill="{color}" transform="translate({x} {y})" d="{data["d"]}"/>'
def svg(w,h,body):return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">{body}</svg>\n'
# Three separate pieces keep the letter legible at icon scale.
mark='<path fill="#f2f0e9" d="M7 54 28 10h10L17 54zm31-34 20 34H46L32 30z"/><path fill="#efbc68" d="M25 34h19l5 9H21z"/>'
(assets/'mark.svg').write_text(svg(64,64,mark))
(assets/'mark-mono.svg').write_text(svg(64,64,mark.replace('#efbc68','#f2f0e9')))
(assets/'mark-ink.svg').write_text(svg(64,64,mark.replace('#f2f0e9','#151615').replace('#efbc68','#151615')))
word=text_path('rya',57,54,72,weight=550)
lockup=f'<g transform="translate(0 0)">{mark}</g>{word}'
# Optical vertical alignment accommodates the wordmark's descender.
(assets/'wordmark.svg').write_text(svg(166,77,lockup))
(assets/'wordmark-ink.svg').write_text(svg(166,77,lockup.replace('#f2f0e9','#151615').replace('#efbc68','#6b4a16')))
icon='<rect x="1" y="1" width="126" height="126" rx="28" fill="#20271e" stroke="#59614b" stroke-width=".7"/><path d="M21 111 96 17" stroke="#465039" stroke-width=".65"/><path d="M17 111h94" stroke="#465039" stroke-width=".65"/><g transform="translate(18 17) scale(1.44)">'+mark+'</g>'
(assets/'icon.svg').write_text(svg(128,128,icon))
# The same cut forms reappear as poster artwork without changing the logo.
sculpture='<circle cx="275" cy="152" r="131" fill="#efbc68"/><path d="m35 415 141-327 47 110L127 415z" fill="#e8e6dc"/><path d="m191 118 144 297h-91L146 206z" fill="#101710"/><path d="m206 143 132 272h43L230 88z" fill="#f2f0e9"/><path d="m127 283 171 0 26 57H102z" fill="#efbc68"/><path d="m127 283 171 0 11 23H116z" fill="#f7d598"/><g fill="none" stroke="#d9dfcf" stroke-width=".8" transform="rotate(-26 240 251)"><ellipse cx="240" cy="251" rx="209" ry="84"/><ellipse cx="240" cy="251" rx="227" ry="99"/></g>'
social='<rect width="1200" height="630" fill="#151615"/><path d="M60 107h1080M60 549h1080" stroke="#444b3a"/>'
social+=f'<g transform="translate(60 28) scale(.7)">{lockup}</g>'
social+=text_path('A VIDEO & MOTION EDITOR',780,68,12,color='#b5b8ae',weight=500)
social+=text_path('Your edit.',58,279,112,weight=450)+text_path('Every layer.',58,402,123,color='#efbc68',weight=400,italic=True)
social+=text_path('Direct your AI. Keep the timeline.',64,592,20,color='#b5b8ae',weight=400)
social+=f'<g transform="translate(730 79) scale(.97)">{sculpture}</g>'
(assets/'social.svg').write_text(svg(1200,630,social))
installer='<rect width="900" height="600" fill="#f2f0e9"/><path d="M50 102h800M50 511h800" stroke="#bdc5b0"/>'
installer+=f'<g transform="translate(48 23) scale(.65)">{lockup.replace("#f2f0e9","#151615").replace("#efbc68","#6b4a16")}</g>'
installer+=text_path('Your edit.',47,244,84,color='#151615',weight=450)+text_path('Every layer.',47,335,93,color='#6b4a16',weight=400,italic=True)
installer+=text_path('A video and motion editor you can direct.',51,388,17,color='#596052',weight=400)
installer+=f'<g transform="translate(585 204) scale(1.3)">{icon}</g>'
installer+=text_path('ARYA FOR MAC',50,551,11,color='#596052',weight=500)
installer+=text_path('Packaging artwork / Release pending',570,551,11,color='#596052',weight=400)
(assets/'installer.svg').write_text(svg(900,600,installer))
board='<rect width="1600" height="1180" fill="#151615"/>'
board+=text_path('Arya / Identity studies',64, 75,24,weight=500)
board+=text_path('01 / MARK, WORDMARK, APPLICATION',1060,73,12,color='#b5b8ae',weight=500)
board+='<path d="M64 112h1472M64 425h1472" stroke="#444b3a"/>'
board+=f'<g transform="translate(78 173) scale(2.5)">{mark}</g><g transform="translate(441 212) scale(1.7)">{lockup}</g><g transform="translate(1210 158) scale(1.7)">{icon}</g>'
board+=text_path('The cut A',77,384,13,color='#b5b8ae',weight=400)+text_path('The wordmark / Outlined geometry',440,384,13,color='#b5b8ae',weight=400)+text_path('The app icon',1210,404,13,color='#b5b8ae',weight=400)
board+=f'<g transform="translate(64 481) scale(.77)">{social}</g>'
board+='<rect x="1048" y="481" width="488" height="485" fill="#f2f0e9"/>'
board+=text_path('A study',1080,574,53,color='#151615',italic=True,weight=400)+text_path('in motion.',1080,632,53,color='#151615',italic=True,weight=400)
board+=f'<g transform="translate(1210 633) scale(.58)">{sculpture}</g>'
board+=text_path('Every part stays yours to edit.',1080,932,13,color='#596052',weight=400)
board+=text_path('Your edit. Every layer.',64,1059,36,weight=400)
board+=text_path('Charcoal · Paper · Amber',1060,1055,17,color='#b5b8ae',weight=400)
for x,c in [(1060,'#20271e'),(1170,'#f2f0e9'),(1280,'#efbc68'),(1390,'#9ba98d')]:board+=f'<rect x="{x}" y="1090" width="80" height="22" fill="{c}"/>'
board+=text_path('Manrope / Newsreader italic / Original artwork',64,1113,14,color='#b5b8ae',weight=400)
(assets/'identity-board.svg').write_text(svg(1600,1180,board))
print('Wrote 9 outlined brand SVG assets.')
