import vfs = require('./vfs');
import gen_js = require('./gen_js');
import compiler = require('./compiler');
import syntax = require('./syntax');
import grammar = require('./grammar');

export function matchStms(src:string) {
	var grammarResult = grammar.match(syntax.Stms, src);
	let errors = grammarResult.context.errors.getErrors();
	if (errors.length > 0) {
		throw new Error(errors.join(','));
	}
	if (!grammarResult.matched) {
		throw new Error(`Not matched ${grammarResult}`);
	}
	if (!grammarResult.eof) {
		throw new Error(`Not end of file ${grammarResult}`);
	}
	if (!grammarResult.complete) {
		throw new Error(`Incomplete matching`);
	}
	return grammarResult;
}

export function compileProgram(src:string):compiler.CompileResult {
	let compilerResult = compiler.compile(matchStms(src).node);
	if (compilerResult.errors.length > 0) {
		throw new Error(`Program had errors [${compilerResult.errors.getErrors().join(',')}]`);
	}
	return compilerResult;
}

export function compile(file:vfs.VfsFile, compact:boolean = false):string {
	let grammarResult = matchStms(file.readString());
	var compilerResult = compiler.compile(grammarResult.node);
	if (compilerResult.errors.length > 0) {
		throw new Error(`Program had errors [${compilerResult.errors.getErrors().join(',')}]`);
	}
	let code = gen_js.generate(compilerResult.module);
	if (compact) code = code.replace(/\s+/mgi, ' ').trim();
	return '(function() { ' + gen_js.generateRuntime() + code + ' return Main.main(); })()';
}