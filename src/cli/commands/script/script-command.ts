import { Injectable } from '@nestjs/common';
import { ScriptService } from '../../../core/services/script/script.service';
import { ScriptAnalysisService } from '../../../core/services/script/script-analysis.service';
import { Rs2asmFormatter } from '../../../core/services/script/rs2asm-formatter';
import { writeFileSync, mkdirSync } from 'node:fs';

@Injectable()
export class ScriptCommand {
  constructor(
    private readonly scriptService: ScriptService,
    private readonly scriptAnalysisService: ScriptAnalysisService
  ) {}

  public async handleList(options: any): Promise<void> {
    console.log('📜 Loading script list...');
    
    if (options.stats) {
      const stats = await this.scriptService.getScriptStatistics();
      console.log('\n📊 Script Statistics:');
      console.log(`Total scripts: ${stats.totalScripts}`);
      console.log(`Named scripts: ${stats.namedScripts}`);
      console.log(`Average code length: ${stats.avgCodeLength} instructions`);
      console.log(`Average argument count: ${stats.avgArgumentCount}`);
      return;
    }

    const metadata = await this.scriptService.getAllScriptMetadata();
    
    if (options.named) {
      const namedScripts = metadata.filter(s => s.name);
      console.log(`\n📝 Named Scripts (${namedScripts.length}):`);
      namedScripts.forEach(script => {
        console.log(`  ${script.id}: ${script.name} (${script.codeLength} instructions, ${script.argumentCountInt + script.argumentCountObject} args)`);
      });
    } else {
      console.log(`\n📋 All Scripts (${metadata.length}):`);
      metadata.slice(0, options.limit || 20).forEach(script => {
        const name = script.name ? ` "${script.name}"` : '';
        console.log(`  ${script.id}:${name} (${script.codeLength} instructions, ${script.argumentCountInt + script.argumentCountObject} args)`);
      });
      
      if (metadata.length > (options.limit || 20)) {
        console.log(`  ... and ${metadata.length - (options.limit || 20)} more (use --limit to see more)`);
      }
    }
  }

  public async handleShow(scriptId: number, options: any): Promise<void> {
    console.log(`🔍 Loading script ${scriptId}...`);
    
    const parsed = await this.scriptService.getParsedScript(scriptId);
    if (!parsed) {
      console.log(`❌ Script ${scriptId} not found`);
      return;
    }

    const { metadata, instructions } = parsed;
    
    console.log(`\n📜 Script ${metadata.id}:`);
    if (metadata.name) {
      console.log(`Name: ${metadata.name}`);
    }
    console.log(`Local variables: ${metadata.localCountInt} int, ${metadata.localCountObject} object`);
    console.log(`Arguments: ${metadata.argumentCountInt} int, ${metadata.argumentCountObject} object`);
    console.log(`Instructions: ${metadata.codeLength} (parsed: ${instructions.length})`);

    if (options.instructions || options.full) {
      console.log(`\n🔧 Instructions:`);
      instructions.slice(0, options.instructionLimit || 50).forEach((inst, idx) => {
        const operandStr = inst.operand !== undefined ? ` ${Rs2asmFormatter.formatOperand(inst.operand)}` : '';
        console.log(`  ${idx.toString().padStart(3, '0')}: ${inst.name}${operandStr}`);
      });
      
      if (instructions.length > (options.instructionLimit || 50)) {
        console.log(`  ... and ${instructions.length - (options.instructionLimit || 50)} more instructions`);
      }
    }

    if (options.raw) {
      console.log(`\n📊 Raw Data (${metadata.rawData.length} bytes):`);
      console.log(`First 100 bytes: ${Array.from(metadata.rawData.slice(0, 100)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    }

    if (options.rs2asm || options.asm) {
      console.log(`\n🔧 RS2ASM Assembly:`);
      const rs2asm = await this.scriptService.getScriptAsRs2asm(scriptId, {
        includeMetadata: true,
        includeComments: true,
        includeAddresses: options.addresses || false,
      });
      if (rs2asm) {
        console.log(rs2asm);
      } else {
        console.log('❌ Failed to generate rs2asm output');
      }
    }
  }

  public async handleDecompile(scriptId: number, options: any): Promise<void> {
    console.log(`🔧 Decompiling script ${scriptId} to rs2asm...`);
    
    const rs2asm = await this.scriptService.getScriptAsRs2asm(scriptId, {
      includeMetadata: options.metadata !== false,
      includeComments: options.comments !== false,
      includeAddresses: options.addresses || false,
    });
    
    if (!rs2asm) {
      console.log(`❌ Script ${scriptId} not found or could not be decompiled`);
      return;
    }

    if (options.output) {
      writeFileSync(options.output, rs2asm);
      console.log(`💾 Saved to ${options.output}`);
    } else {
      console.log(rs2asm);
    }
  }

  public async handleSearch(searchTerm: string, options: any): Promise<void> {
    console.log(`🔍 Searching scripts for: "${searchTerm}"`);
    
    const results = await this.scriptService.findScriptsByName(searchTerm);
    
    if (results.length === 0) {
      console.log('❌ No scripts found matching the search term');
      return;
    }

    console.log(`\n✅ Found ${results.length} script(s):`);
    results.forEach(script => {
      console.log(`  ${script.id}: ${script.name} (${script.codeLength} instructions)`);
    });
  }

  public async handleIds(options: any): Promise<void> {
    console.log('📋 Loading script IDs...');
    
    const ids = await this.scriptService.getAllScriptIds();
    
    console.log(`\n📊 Found ${ids.length} scripts:`);
    
    if (options.range) {
      console.log(`Range: ${Math.min(...ids)} - ${Math.max(...ids)}`);
    }
    
    if (options.list) {
      const sortedIds = ids.sort((a, b) => a - b);
      console.log('IDs:', sortedIds.slice(0, options.limit || 100).join(', '));
      
      if (sortedIds.length > (options.limit || 100)) {
        console.log(`... and ${sortedIds.length - (options.limit || 100)} more`);
      }
    }
  }

  public async handleAnalyze(scriptId: number, options: any): Promise<void> {
    console.log(`🔍 Analyzing script ${scriptId}...`);
    
    try {
      const analysis = await this.scriptAnalysisService.analyzeScript(scriptId);
      
      console.log(`\n📊 Script Analysis Results:`);
      console.log(`Script ID: ${analysis.scriptId}`);
      console.log(`Variable References: ${analysis.variableReferences.length}`);
      console.log(`Varps: ${analysis.varps.length} (${analysis.varps.join(', ')})`);
      console.log(`Varbits: ${analysis.varbits.length} (${analysis.varbits.join(', ')})`);
      console.log(`Varcs: ${analysis.varcs.length} (${analysis.varcs.join(', ')})`);
      
      console.log(`\n🔍 Pattern Analysis:`);
      console.log(`Combat Achievement Pattern: ${analysis.patterns.isCombatAchievementPattern ? '✅' : '❌'}`);
      console.log(`Has Switch: ${analysis.patterns.hasSwitch ? '✅' : '❌'}`);
      console.log(`Has Testbit Operations: ${analysis.patterns.hasTestbitOperations ? '✅' : '❌'}`);
      
      if (options.details || options.verbose) {
        console.log(`\n📋 Variable References:`);
        analysis.variableReferences.forEach((ref, idx) => {
          console.log(`  ${idx + 1}. ${ref.type.toUpperCase()} ${ref.varId} (${ref.operation}) - ${ref.instruction.name}`);
        });
      }
      
      if (options.taskVarps || analysis.patterns.isCombatAchievementPattern) {
        console.log(`\n🎯 Task Varps (for task-json):`);
        console.log(`"taskVarps": [${analysis.varps.join(', ')}]`);
      }
      
    } catch (error) {
      console.log(`❌ Failed to analyze script ${scriptId}:`, error.message);
    }
  }

  public async handleGet(scriptId: number, options: any): Promise<void> {
    console.log(`📥 Getting script ${scriptId}...`);
    
    try {
      const parsed = await this.scriptService.getParsedScript(scriptId);
      if (!parsed) {
        console.log(`❌ Script ${scriptId} not found`);
        return;
      }

      const { metadata } = parsed;
      const scriptName = metadata.name ? metadata.name.replace(/[^a-z0-9_-]/gi, '_') : `script_${scriptId}`;
      const fileName = `./out/${scriptName}.rs2asm`;
      
      const rs2asm = await this.scriptService.getScriptAsRs2asm(scriptId, {
        includeMetadata: true,
        includeComments: true,
        includeAddresses: false,
      });
      
      if (!rs2asm) {
        console.log(`❌ Failed to generate rs2asm for script ${scriptId}`);
        return;
      }
      
      mkdirSync('./out', { recursive: true });
      writeFileSync(fileName, rs2asm);
      console.log(`✅ Script saved to ${fileName}`);
      
    } catch (error) {
      console.log(`❌ Failed to get script ${scriptId}:`, error.message);
    }
  }
}
