import type { SourceFile } from './protocol';
import gold from '../test/fixtures/gold/app.R';
import silver from '../test/fixtures/silver/app.R';
import bronze from '../test/fixtures/bronze/app.R';
import none from '../test/fixtures/none/app.R';
import param from '../test/fixtures/param/helper.R';

/** the test fixtures, one per tier, as examples to start from; the file name says which one is analyzed */
export const Examples: readonly { label: string, title: string, files: SourceFile[] }[] = [
	{ label: 'gold', title: 'a Shiny app that only draws a plot', files: [{ path: 'example-gold.R', content: gold }] },
	{ label: 'silver', title: 'a shell command that is a constant', files: [{ path: 'example-silver.R', content: silver }] },
	{ label: 'bronze', title: 'user input passed to glue, which evaluates it inside the package', files: [{ path: 'example-bronze.R', content: bronze }] },
	{ label: 'none', title: 'user input passed to system()', files: [{ path: 'example-none.R', content: none }] },
	{ label: 'parameter', title: 'a function parameter passed to system()', files: [{ path: 'example-parameter.R', content: param }] }
];
