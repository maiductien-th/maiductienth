#!/usr/bin/env python3
"""Resolve IL2CPP metadata-usage slots in libil2cpp.so to names.

The slots that feed il2cpp string/type/method arguments are zero in the file;
their values come from R_AARCH64_RELATIVE relocations applied at load time, so
they are statically determinable. This joins capstone disassembly to the
.rela.dyn addends and the Il2CppDumper script.json tables, annotating each
`adrp`+`ldr` pair with the string, type or method the slot resolves to.

Run from the repository root, after tools/build.sh has produced
out/recovered/script.json and in/apk/lib/arm64-v8a/libil2cpp.so:

    python3 tools/resolve_slots.py 0x17298B4 0x1729C40

Requires: pip install capstone
"""
import struct, json, sys
from capstone import *
F=open('in/apk/lib/arm64-v8a/libil2cpp.so','rb').read()
DELTA=0x13f8a7c-0x13f4a7c
md=Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN); md.detail=True
RELOC={}
off,size=0x35860,0x856260
for i in range(size//24):
    o=off+i*24
    r_off,r_info,r_add=struct.unpack_from('<QQq',F,o)
    RELOC[r_off]=r_add
D=json.load(open('out/recovered/script.json'))
SS={e['Address']:e['Value'] for e in D['ScriptString']}
SM={e['Address']:e['Name'] for e in D['ScriptMetadata']}
MET={e['Address']:e['Name'] for e in D['ScriptMethod']}
MM={e['Address']:e['Name'] for e in D['ScriptMetadataMethod']}
def label(slot):
    a=RELOC.get(slot)
    if a is None: return None
    if a in SS: return 'STR %r'%SS[a]
    if a in SM: return 'TYPE %s'%SM[a]
    if a in MM: return 'METHODINFO %s'%MM[a]
    if a in MET: return 'CODE %s'%MET[a]
    return '0x%x'%a
def dis(start,end):
    pages={}
    off=start-DELTA
    for i in md.disasm(F[off:off+(end-start)], start):
        s=f'0x{i.address:x}: {i.mnemonic} {i.op_str}'
        written=set()
        try:
            regs_r,regs_w=i.regs_access()
            written={i.reg_name(r) for r in regs_w}
        except Exception: pass
        if i.mnemonic=='adrp':
            r,p=[x.strip() for x in i.op_str.split(',')]
            pages[r]=int(p.lstrip('#'),16); written=set()
        elif i.mnemonic=='ldr' and '[' in i.op_str:
            inner=i.op_str[i.op_str.index('[')+1:i.op_str.index(']')]
            parts=[x.strip() for x in inner.split(',')]
            base=parts[0]
            imm=int(parts[1].lstrip('#'),16) if len(parts)>1 else 0
            if pages.get(base) is not None:
                slot=pages[base]+imm
                lb=label(slot)
                if lb: s+=f'   ; [0x{slot:x}] = {lb}'
        elif i.mnemonic=='bl':
            t=int(i.op_str.strip().lstrip('#'),16)
            if t in MET: s+=f'   ; -> {MET[t]}'
        for w in written:
            if w in pages: pages[w]=None
        print(s)
dis(int(sys.argv[1],16),int(sys.argv[2],16))
